#!/usr/bin/env bash
# Entry point of the `backup` container: waits for MySQL to accept the backup account (a login test: `mysqladmin ping` also succeeds when the login is refused), then runs the loop.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional, like the account the migrate job creates from it: a deployment without the variable runs
# exactly as before, and this container just says so and idles (healthy) instead of failing the stack.
if [ -z "${OPSLOG_BACKUP_PASSWORD:-}" ]; then
  echo '{"level":"warn","msg":"backup_disabled_no_password"}' >&2
  exec sleep infinity
fi
for _ in $(seq 1 60); do
  if MYSQL_PWD="$OPSLOG_BACKUP_PASSWORD" mysql --host="${OPSLOG_BACKUP_HOST:-mysql}" --port="${OPSLOG_BACKUP_PORT:-3306}" \
    --user="${OPSLOG_BACKUP_USER:-opslog_backup}" --protocol=TCP --execute='SELECT 1' >/dev/null 2>&1; then
    exec "$here/backup.sh" run
  fi
  sleep 5
done
echo '{"level":"error","msg":"backup_mysql_unavailable"}' >&2
exit 1
