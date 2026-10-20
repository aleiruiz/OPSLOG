#!/usr/bin/env bash
# Shared helpers of the operations scripts (backup and restore). Sourced, never executed.
# Offline by design: the only network the scripts use is the MySQL connection they are given.

# Files these scripts create (sums, reports, temporary data) are owner-only.
umask 077

# Event lines are JSON like the API's: ts, level, msg (an event code), and numeric fields only.
# Never pass a value that could hold personal data, a password or a path with user input.
log() {
  local level="$1" msg="$2" extra="" key value
  shift 2
  while [ "$#" -ge 2 ]; do
    key="$1" value="$2"
    case "$value" in '' | *[!0-9]*) value=0 ;; esac
    extra="$extra,\"$key\":$value"
    shift 2
  done
  printf '{"ts":"%s","level":"%s","msg":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$msg" "$extra" >&2
}

die() {
  log error "$1"
  exit "${2:-1}"
}

# Client programs; overridable so a host without the packages can point at a mysql:8.4 image's tools.
MYSQL="${MYSQL:-mysql}"
MYSQLDUMP="${MYSQLDUMP:-mysqldump}"
MYSQLBINLOG="${MYSQLBINLOG:-mysqlbinlog}"

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "missing_tool_$(basename "$tool" | tr -c 'a-z0-9\n' '_')"
  done
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# Writes `<file>.sha256` in sha256sum format, with the bare file name so it verifies from its folder.
write_sum() {
  local file="$1"
  (cd "$(dirname "$file")" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
}

verify_sum() {
  local file="$1"
  [ -f "$file" ] && [ -f "$file.sha256" ] || return 1
  (cd "$(dirname "$file")" && sha256sum --check --status "$(basename "$file").sha256")
}

mtime_of() { stat -c %Y "$1"; }
