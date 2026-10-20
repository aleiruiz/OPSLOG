#!/usr/bin/env bash
# A throw-away MySQL instance to restore into (SPECS §9.3: restore to a temporary instance, never
# over the main one).
#
#   temp-instance.sh start <name> <port> [driver]   prints `OPSLOG_RESTORE_*` lines to eval
#   temp-instance.sh stop  <name> [driver]
#
# Drivers: `docker` (default; a disposable mysql:8.4 container, published on 127.0.0.1 only) and
# `local` (a second mysqld from the host's packages on its own data directory under
# OPSLOG_TEMP_ROOT, default $TMPDIR/opslog-temp). The local driver is what the offline drill uses.
# The instance has an empty root password and listens on 127.0.0.1 only: it holds restored data for
# minutes and must not be reachable from outside.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

MYSQLD="${MYSQLD:-mysqld}"
MYSQLADMIN="${MYSQLADMIN:-mysqladmin}"
IMAGE="${OPSLOG_RESTORE_IMAGE:-mysql:8.4}"
ROOT="${OPSLOG_TEMP_ROOT:-${TMPDIR:-/tmp}/opslog-temp}"
# Extra server options (for the local driver), e.g. a binlog on the source instance of the drill.
EXTRA="${OPSLOG_TEMP_MYSQLD_OPTIONS:-}"

wait_ready() {
  local port="$1" _
  for _ in $(seq 1 90); do
    if "$MYSQLADMIN" --host=127.0.0.1 --port="$port" --user=root --protocol=TCP ping --silent >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die temp_instance_not_ready
}

start_local() {
  local name="$1" port="$2" dir="$ROOT/$1"
  require_tools "$MYSQLD" "$MYSQLADMIN"
  [ ! -e "$dir" ] || die temp_instance_exists
  mkdir -p "$dir"
  "$MYSQLD" --no-defaults --user="$(id -un)" --initialize-insecure --datadir="$dir/data" >"$dir/init.log" 2>&1 || die temp_instance_init_failed
  # shellcheck disable=SC2086
  nohup "$MYSQLD" --no-defaults --user="$(id -un)" --datadir="$dir/data" --port="$port" --bind-address=127.0.0.1 \
    --socket="$dir/mysql.sock" --pid-file="$dir/mysqld.pid" --mysqlx=OFF --performance-schema=OFF \
    --innodb-buffer-pool-size=64M --max-connections=60 --server-id="${OPSLOG_TEMP_SERVER_ID:-7}" $EXTRA >"$dir/server.log" 2>&1 &
  echo "$!" >"$dir/launcher.pid"
  wait_ready "$port"
}

stop_local() {
  local name="$1" dir="$ROOT/$1" pid
  [ -d "$dir" ] || return 0
  if [ -f "$dir/mysqld.pid" ]; then
    pid="$(cat "$dir/mysqld.pid")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -rf "$dir"
}

case "${1:-}" in
  start)
    name="${2:?name}" port="${3:?port}" driver="${4:-docker}"
    case "$driver" in
      local) start_local "$name" "$port" ;;
      docker)
        require_tools docker
        docker run -d --rm --name "opslog-restore-$name" -p "127.0.0.1:$port:3306" -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
          "$IMAGE" --performance-schema=OFF --innodb-buffer-pool-size=128M >/dev/null
        wait_ready "$port"
        ;;
      *) die temp_instance_unknown_driver 2 ;;
    esac
    printf 'OPSLOG_RESTORE_HOST=127.0.0.1\nOPSLOG_RESTORE_PORT=%s\nOPSLOG_RESTORE_USER=root\n' "$port"
    ;;
  stop)
    name="${2:?name}" driver="${3:-docker}"
    case "$driver" in
      local) stop_local "$name" ;;
      docker) docker rm -f "opslog-restore-$name" >/dev/null 2>&1 || true ;;
      *) die temp_instance_unknown_driver 2 ;;
    esac
    ;;
  *) die usage_temp_instance_start_stop 2 ;;
esac
