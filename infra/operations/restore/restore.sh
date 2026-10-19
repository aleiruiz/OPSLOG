#!/usr/bin/env bash
# Restores the OPSLOG databases from the backup volume into a TEMPORARY MySQL instance: loads the
# newest dump not after the requested instant, replays the copied binary logs up to it, and checks
# row counts and table checksums. It never touches the main instance: copying a validated database
# there is a manual step (README, "Copy a restored company back").
#
#   restore.sh --backup-dir DIR --host H --port P [--user root] [--until 'YYYY-MM-DD HH:MM:SS']
#              [--database opslog_t_x] [--expect FILE] [--fingerprint-out FILE] [--report FILE]
#              [--allow-nonempty]
#
# --until is UTC and defaults to "everything that was copied". --database restores one company
# (SPECS §9.3: restore to a temporary instance and extract the validated tenant) and replays only
# its events. The target password is read from MYSQL_PWD (empty for a fresh temporary instance).
# Refuses a target that already holds opslog_t_* databases unless --allow-nonempty is given, so a
# main instance cannot be overwritten by mistake.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

BACKUP="" HOST="" PORT="" USER_NAME="root" UNTIL="" ONLY="" EXPECT="" FP_OUT="" REPORT="" NONEMPTY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup-dir) BACKUP="$2" ;;
    --host) HOST="$2" ;;
    --port) PORT="$2" ;;
    --user) USER_NAME="$2" ;;
    --until) UNTIL="$2" ;;
    --database) ONLY="$2" ;;
    --expect) EXPECT="$2" ;;
    --fingerprint-out) FP_OUT="$2" ;;
    --report) REPORT="$2" ;;
    --allow-nonempty) NONEMPTY=1; shift; continue ;;
    *) die restore_unknown_option 2 ;;
  esac
  shift 2
done
[ -d "$BACKUP/dumps" ] && [ -n "$HOST" ] && [ -n "$PORT" ] || die restore_needs_backup_dir_host_port 2
[ -z "$ONLY" ] || [[ "$ONLY" =~ ^opslog_t_[a-zA-Z0-9_]{1,100}$ ]] || die restore_bad_database_name 2
[ -z "$UNTIL" ] || [[ "$UNTIL" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || die restore_bad_until 2
require_tools "$MYSQL" "$MYSQLBINLOG" gzip sha256sum

mysql_t() { "$MYSQL" --host="$HOST" --port="$PORT" --user="$USER_NAME" --protocol=TCP "$@"; }
meta_value() { sed -n "s/^$2=//p" "$1" | head -n 1; }
started="$(date +%s)"

existing="$(mysql_t --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE 'opslog\\\\_t\\\\_%'")"
if [ "$existing" != "0" ] && [ "$NONEMPTY" != "1" ]; then die restore_target_not_empty 3; fi

# 1. The dump: newest whose stamp is not after the requested instant.
limit=""
[ -z "$UNTIL" ] || limit="$(date -u -d "$UNTIL UTC" +%Y%m%dT%H%M%SZ)"
meta=""
for candidate in $(ls -1r "$BACKUP"/dumps/opslog-*.meta 2>/dev/null); do
  stamp="$(meta_value "$candidate" created_utc)"
  if [ -z "$limit" ] || [[ ! "$stamp" > "$limit" ]]; then meta="$candidate"; break; fi
done
[ -n "$meta" ] || die restore_no_dump_before_instant 4
dump="${meta%.meta}.sql.gz"
verify_sum "$meta" || die restore_meta_checksum_mismatch 5
verify_sum "$dump" || die restore_dump_checksum_mismatch 5
[ "$(sha256_of "$dump")" = "$(meta_value "$meta" dump_sha256)" ] || die restore_dump_checksum_mismatch 5
log info restore_dump_verified

# 2. Load it.
if [ -n "$ONLY" ]; then
  # --one-database keeps only the statements that run while the named database is the default one.
  mysql_t -e "CREATE DATABASE IF NOT EXISTS \`$ONLY\` CHARACTER SET utf8mb4"
  schemas_before="$(mysql_t --batch --skip-column-names -e 'SHOW DATABASES')"
  gzip -dc "$dump" | mysql_t --one-database "$ONLY"
  # The dump's CREATE DATABASE lines of the other companies still run (they precede their USE);
  # drop the empty databases this run created, and only those.
  while IFS= read -r schema; do
    [ "$schema" != "$ONLY" ] || continue
    printf '%s\n' "$schemas_before" | grep -qxF "$schema" && continue
    mysql_t -e "DROP DATABASE \`$schema\`"
  done < <(mysql_t --batch --skip-column-names -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'opslog\\\\_t\\\\_%'")
else
  gzip -dc "$dump" | mysql_t
fi
log info restore_dump_loaded

# 3. Replay the binary logs from the dump's position, in order and without gaps.
uuid="$(meta_value "$meta" server_uuid)"
first="$(meta_value "$meta" binlog_file)"
pos="$(meta_value "$meta" binlog_pos)"
logs_dir="$BACKUP/binlogs/$uuid"
prefix="${first%.*}"
first_number=$((10#${first##*.}))
files=()
expected_number="$first_number"
if [ -d "$logs_dir" ]; then
  for file in $(ls -1 "$logs_dir" 2>/dev/null | grep -E "^${prefix//./\\.}\\.[0-9]+$" | sort); do
    number=$((10#${file##*.}))
    [ "$number" -ge "$first_number" ] || continue
    [ "$number" -eq "$expected_number" ] || die restore_binlog_gap 6
    verify_sum "$logs_dir/$file" || die restore_binlog_checksum_mismatch 5
    files+=("$logs_dir/$file")
    expected_number=$((expected_number + 1))
  done
fi
if [ "${#files[@]}" -gt 0 ]; then
  args=(--start-position="$pos" --skip-gtids)
  [ -z "$UNTIL" ] || args+=(--stop-datetime="$UNTIL")
  [ -z "$ONLY" ] || args+=(--database="$ONLY")
  # mysqlbinlog reads --stop-datetime in the local time zone of this machine: pin it to UTC.
  TZ=UTC "$MYSQLBINLOG" "${args[@]}" "${files[@]}" | mysql_t --binary-mode
else
  log warn restore_no_binlogs_after_dump
fi
log info restore_binlogs_replayed files "${#files[@]}"

# 4. Verify: counts and checksums per table, against the source's fingerprint when given.
fingerprint_args=(--host "$HOST" --port "$PORT" --user "$USER_NAME")
[ -z "$ONLY" ] || fingerprint_args+=(--database "$ONLY")
actual="$(mktemp)"
trap 'rm -f "$actual"' EXIT
"$here/fingerprint.sh" "${fingerprint_args[@]}" >"$actual"
[ -z "$FP_OUT" ] || cp "$actual" "$FP_OUT"
verified="not_requested"
if [ -n "$EXPECT" ]; then
  expected_filtered="$(mktemp)"
  trap 'rm -f "$actual" "$expected_filtered"' EXIT
  if [ -n "$ONLY" ]; then awk -F'\t' -v db="$ONLY" '$1 == db' "$EXPECT" | LC_ALL=C sort >"$expected_filtered"; else LC_ALL=C sort "$EXPECT" >"$expected_filtered"; fi
  if cmp -s "$expected_filtered" "$actual"; then verified="yes"; else verified="no"; fi
fi
tables="$(wc -l <"$actual" | tr -d ' ')"
rows="$(awk -F'\t' '{ n += $3 } END { print n + 0 }' "$actual")"
seconds=$(($(date +%s) - started))
if [ -n "$REPORT" ]; then
  {
    printf 'dump=%s\n' "$(basename "$dump")"
    printf 'binlog_files=%s\n' "${#files[@]}"
    printf 'until=%s\n' "${UNTIL:-latest}"
    printf 'tables=%s\nrows=%s\n' "$tables" "$rows"
    printf 'verified=%s\n' "$verified"
    printf 'restore_seconds=%s\n' "$seconds"
  } >"$REPORT"
fi
log info restore_done tables "$tables" rows "$rows" seconds "$seconds"
[ "$verified" != "no" ] || die restore_verify_mismatch 7
