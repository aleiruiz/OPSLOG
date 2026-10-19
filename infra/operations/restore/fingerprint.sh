#!/usr/bin/env bash
# Per-table row counts and CHECKSUM TABLE of the OPSLOG databases, as sorted TSV
# (`database<TAB>table<TAB>rows<TAB>checksum`). The restore compares it with a file taken from the
# source ("restored equals what was backed up"); the drill takes both sides.
#
#   fingerprint.sh --host H --port P [--user U] [--database NAME]   (password: MYSQL_PWD)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

HOST="" PORT="" USER_NAME="root" ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="$2" ;;
    --port) PORT="$2" ;;
    --user) USER_NAME="$2" ;;
    --database) ONLY="$2" ;;
    *) die fingerprint_unknown_option 2 ;;
  esac
  shift 2
done
[ -n "$HOST" ] && [ -n "$PORT" ] || die fingerprint_needs_host_and_port 2
[ -z "$ONLY" ] || [[ "$ONLY" =~ ^opslog_t_[a-zA-Z0-9_]{1,100}$ ]] || die fingerprint_bad_database_name 2

mysql_q() { "$MYSQL" --host="$HOST" --port="$PORT" --user="$USER_NAME" --protocol=TCP --batch --skip-column-names "$@"; }

filter="table_schema LIKE 'opslog\\\\_t\\\\_%'"
[ -z "$ONLY" ] || filter="table_schema = '$ONLY'"
mapfile -t tables < <(mysql_q -e "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND $filter ORDER BY 1, 2")
[ "${#tables[@]}" -gt 0 ] || die fingerprint_no_tables

# Two statements in one session: the counts (UNION ALL) and one CHECKSUM TABLE over every table.
counts_sql="" checksum_list=""
for entry in "${tables[@]}"; do
  schema="${entry%%$'\t'*}"
  table="${entry#*$'\t'}"
  counts_sql+="${counts_sql:+ UNION ALL }SELECT '$schema.$table', COUNT(*) FROM \`$schema\`.\`$table\`"
  checksum_list+="${checksum_list:+, }\`$schema\`.\`$table\`"
done
counts="$(mktemp)" sums="$(mktemp)"
trap 'rm -f "$counts" "$sums"' EXIT
mysql_q -e "$counts_sql" >"$counts"
mysql_q -e "CHECKSUM TABLE $checksum_list" >"$sums"
# Both files are `schema.table<TAB>value`; join on the name and split it back into two columns.
LC_ALL=C join -t $'\t' <(LC_ALL=C sort "$counts") <(LC_ALL=C sort "$sums") |
  awk -F'\t' '{ split($1, name, "."); printf "%s\t%s\t%s\t%s\n", name[1], name[2], $2, $3 }' |
  LC_ALL=C sort
