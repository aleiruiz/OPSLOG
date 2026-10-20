#!/usr/bin/env bash
# Backup of the OPSLOG databases: daily logical dump plus a copy of the closed binary logs.
#
#   backup.sh dump        mysqldump --single-transaction --source-data=2 --routines --triggers
#   backup.sh binlogs     FLUSH BINARY LOGS, then copy every closed binlog not yet copied
#   backup.sh retention   delete what is older than OPSLOG_BACKUP_RETENTION_DAYS (35)
#   backup.sh run         the container loop: dumps daily, copies binlogs every 15 minutes
#   backup.sh health      exit 0 when the last binlog copy is recent enough
#
# Configuration (environment). The password is read from the environment and handed to the MySQL
# client as MYSQL_PWD, so it is never on a command line.
#   OPSLOG_BACKUP_DIR                    default /backups
#   OPSLOG_BACKUP_HOST / _PORT / _USER   default mysql / 3306 / opslog_backup
#   OPSLOG_BACKUP_PASSWORD               required
#   OPSLOG_BACKUP_RETENTION_DAYS         default 35
#   OPSLOG_BACKUP_BINLOG_INTERVAL        seconds between binlog copies, default 900 (15 minutes)
#   OPSLOG_BACKUP_DUMP_HOUR              UTC hour of the daily dump, default 3
# Layout under OPSLOG_BACKUP_DIR:
#   dumps/opslog-<UTC stamp>.sql.gz  + .sha256, and opslog-<stamp>.meta + .sha256
#   binlogs/<server uuid>/<binlog name> + .sha256
#   status/last-dump, status/last-binlog   (epoch seconds, for the health check)
# OPSLOG_PII_MASTER_KEY is never read or stored here: keep it apart from this volume (see README).
set -euo pipefail
# Backups hold every company's data: owner-only files and directories.
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

DIR="${OPSLOG_BACKUP_DIR:-/backups}"
HOST="${OPSLOG_BACKUP_HOST:-mysql}"
PORT="${OPSLOG_BACKUP_PORT:-3306}"
USER_NAME="${OPSLOG_BACKUP_USER:-opslog_backup}"
RETENTION_DAYS="${OPSLOG_BACKUP_RETENTION_DAYS:-35}"
BINLOG_INTERVAL="${OPSLOG_BACKUP_BINLOG_INTERVAL:-900}"
DUMP_HOUR="${OPSLOG_BACKUP_DUMP_HOUR:-3}"

case "$RETENTION_DAYS$BINLOG_INTERVAL$DUMP_HOUR$PORT" in '' | *[!0-9]*) die backup_config_not_numeric ;; esac
[ "$BINLOG_INTERVAL" -ge 1 ] || die backup_config_interval

# Temporary files of the running command, removed on any exit.
CLEANUP=()
cleanup() { [ "${#CLEANUP[@]}" -eq 0 ] || rm -rf "${CLEANUP[@]}"; }
trap cleanup EXIT

mysql_q() { MYSQL_PWD="${OPSLOG_BACKUP_PASSWORD:?OPSLOG_BACKUP_PASSWORD is required}" "$MYSQL" --host="$HOST" --port="$PORT" --user="$USER_NAME" --protocol=TCP --batch --skip-column-names "$@"; }

# The names of the company databases the account can see (`opslog_t_<name>`).
list_databases() {
  mysql_q <<'SQL'
SHOW DATABASES LIKE 'opslog\\_t\\_%';
SQL
}

cmd_dump() {
  require_tools "$MYSQL" "$MYSQLDUMP" gzip sha256sum
  mkdir -p "$DIR/dumps" "$DIR/status"
  local databases stamp base tmp position file pos uuid
  mapfile -t databases < <(list_databases)
  [ "${#databases[@]}" -gt 0 ] || die backup_no_databases
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="$DIR/dumps/opslog-$stamp"
  tmp="$base.sql.gz.partial"
  uuid="$(mysql_q -e 'SELECT @@server_uuid')"
  CLEANUP+=("$tmp")
  # --single-transaction: a consistent snapshot without locking writers; --source-data=2 writes the
  # binlog position as a comment, which is where the restore starts replaying.
  MYSQL_PWD="$OPSLOG_BACKUP_PASSWORD" "$MYSQLDUMP" --host="$HOST" --port="$PORT" --user="$USER_NAME" --protocol=TCP \
    --single-transaction --source-data=2 --routines --triggers --no-tablespaces --hex-blob \
    --default-character-set=utf8mb4 --databases "${databases[@]}" | gzip -c >"$tmp"
  gzip -t "$tmp" || die backup_dump_corrupt
  position="$(gzip -dc "$tmp" | sed -n -e "s/^-- CHANGE \(MASTER\|REPLICATION SOURCE\) TO \(MASTER\|SOURCE\)_LOG_FILE='\([^']*\)', \(MASTER\|SOURCE\)_LOG_POS=\([0-9]*\);.*/\3 \5/p" | head -n 1 || true)"
  [ -n "$position" ] || die backup_dump_without_position
  file="${position% *}"
  pos="${position#* }"
  mv "$tmp" "$base.sql.gz"
  write_sum "$base.sql.gz"
  {
    printf 'created_utc=%s\n' "$stamp"
    printf 'server_uuid=%s\n' "$uuid"
    printf 'binlog_file=%s\n' "$file"
    printf 'binlog_pos=%s\n' "$pos"
    printf 'databases=%s\n' "${databases[*]}"
    printf 'dump_sha256=%s\n' "$(sha256_of "$base.sql.gz")"
    printf 'server_version=%s\n' "$(mysql_q -e 'SELECT VERSION()')"
  } >"$base.meta"
  write_sum "$base.meta"
  date +%s >"$DIR/status/last-dump"
  log info backup_dump_done dumpBytes "$(stat -c %s "$base.sql.gz")" databases "${#databases[@]}"
}

cmd_binlogs() {
  require_tools "$MYSQL" "$MYSQLBINLOG" sha256sum
  local uuid dest tmp name copied=0 names active now
  uuid="$(mysql_q -e 'SELECT @@server_uuid')"
  dest="$DIR/binlogs/$uuid"
  mkdir -p "$dest" "$DIR/status"
  # Closing the active log makes every earlier one immutable, so each is copied exactly once. The
  # flush is skipped when the active log is exactly as it was right after the previous flush (an idle
  # stack would otherwise produce an empty log every interval), but never for longer than four
  # intervals. The state is read right after the flush, BEFORE the copy: a write that lands while
  # the copy runs makes the active log differ from it, so the next run closes and copies it even if
  # the system then stays idle.
  now="$(date +%s)"
  active="$(mysql_q -e 'SHOW BINARY LOGS' | tail -n 1 | cut -f1,2)"
  if [ ! -f "$DIR/status/active-log" ] || [ "$(cat "$DIR/status/active-log")" != "$active" ] \
    || [ ! -f "$DIR/status/last-flush" ] || [ $((now - $(cat "$DIR/status/last-flush"))) -ge $((BINLOG_INTERVAL * 4)) ]; then
    mysql_q -e 'FLUSH BINARY LOGS'
    date +%s >"$DIR/status/last-flush"
  fi
  mysql_q -e 'SHOW BINARY LOGS' | tail -n 1 | cut -f1,2 >"$DIR/status/active-log"
  mapfile -t names < <(mysql_q -e 'SHOW BINARY LOGS' | cut -f1)
  [ "${#names[@]}" -ge 2 ] || { date +%s >"$DIR/status/last-binlog"; log info backup_binlogs_none; return 0; }
  tmp="$(mktemp -d "$dest/.copy.XXXXXX")"
  CLEANUP+=("$tmp")
  # The last name is the new active log; everything before it is closed.
  for name in "${names[@]:0:${#names[@]}-1}"; do
    if verify_sum "$dest/$name" 2>/dev/null; then continue; fi
    MYSQL_PWD="$OPSLOG_BACKUP_PASSWORD" "$MYSQLBINLOG" --read-from-remote-server --host="$HOST" --port="$PORT" \
      --user="$USER_NAME" --protocol=TCP --raw --result-file="$tmp/" "$name"
    [ -s "$tmp/$name" ] || die backup_binlog_empty
    mv "$tmp/$name" "$dest/$name"
    write_sum "$dest/$name"
    copied=$((copied + 1))
  done
  date +%s >"$DIR/status/last-binlog"
  log info backup_binlogs_done copied "$copied"
}

cmd_retention() {
  local cutoff newest_dump newest_time file base removed=0 stem
  cutoff=$(($(date +%s) - RETENTION_DAYS * 86400))
  # Never delete the newest dump, nor anything newer than it: if backups stalled for longer than the
  # retention, the last good dump and the logs after it are all that is left to restore from.
  newest_dump="$(ls -1 "$DIR"/dumps/opslog-*.sql.gz 2>/dev/null | sort | tail -n 1 || true)"
  stem=""
  if [ -n "$newest_dump" ]; then
    stem="${newest_dump%.sql.gz}"
    newest_time="$(mtime_of "$newest_dump")"
    [ "$newest_time" -lt "$cutoff" ] && cutoff="$newest_time"
  fi
  for file in "$DIR"/dumps/opslog-* "$DIR"/binlogs/*/*; do
    [ -f "$file" ] || continue
    base="$(basename "$file")"
    case "$base" in .copy.*) continue ;; esac
    # The newest dump and its three companions (checksum, metadata, metadata checksum) stay.
    case "$file" in "$stem".sql.gz | "$stem".sql.gz.sha256 | "$stem".meta | "$stem".meta.sha256) [ -n "$stem" ] && continue ;; esac
    if [ "$(mtime_of "$file")" -lt "$cutoff" ]; then
      rm -f "$file"
      removed=$((removed + 1))
    fi
  done
  log info backup_retention_done removed "$removed"
}

cmd_health() {
  # Without a password the service is switched off (entrypoint.sh): nothing to be late.
  [ -n "${OPSLOG_BACKUP_PASSWORD:-}" ] || exit 0
  local last now
  [ -f "$DIR/status/last-binlog" ] || exit 1
  last="$(cat "$DIR/status/last-binlog")"
  now="$(date +%s)"
  [ $((now - last)) -le $((BINLOG_INTERVAL * 3)) ]
}

# True when the daily dump is due: none yet, one at DUMP_HOUR (UTC) once the last is about a day
# old, or a catch-up when it is more than 30 hours old (the container was down).
dump_due() {
  local age
  [ -f "$DIR/status/last-dump" ] || return 0
  age=$(($(date +%s) - $(cat "$DIR/status/last-dump")))
  [ "$age" -ge 108000 ] && return 0
  [ "$age" -ge 72000 ] && [ "$(date -u +%-H)" -ge "$DUMP_HOUR" ]
}

cmd_run() {
  local last_binlog=0 last_dump_try=0 now
  log info backup_started interval "$BINLOG_INTERVAL" retentionDays "$RETENTION_DAYS"
  while true; do
    now="$(date +%s)"
    # Failures are logged and retried: a dump after 15 minutes, the binlog copy on its interval.
    if [ $((now - last_dump_try)) -ge 900 ] && dump_due; then
      last_dump_try="$now"
      # Separate processes: `set -e` does not apply inside a function that is part of an `||` list.
      { bash "${BASH_SOURCE[0]}" dump && bash "${BASH_SOURCE[0]}" retention; } || log error backup_dump_failed
    fi
    if [ $((now - last_binlog)) -ge "$BINLOG_INTERVAL" ]; then
      last_binlog="$now"
      bash "${BASH_SOURCE[0]}" binlogs || log error backup_binlogs_failed
    fi
    sleep 30
  done
}

case "${1:-}" in
  dump) cmd_dump ;;
  binlogs) cmd_binlogs ;;
  retention) cmd_retention ;;
  health) cmd_health ;;
  run) cmd_run ;;
  *) die "usage_backup_dump_binlogs_retention_health_run" 2 ;;
esac
