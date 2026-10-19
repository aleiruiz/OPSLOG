#!/usr/bin/env bash
# Entry point of the `backup` container: waits for MySQL to accept the backup account (a login test: `mysqladmin ping` also succeeds when the login is refused), then runs the loop.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${OPSLOG_BACKUP_PASSWORD:?OPSLOG_BACKUP_PASSWORD is required (also set it on the migrate job, which creates the account)}"
for _ in $(seq 1 60); do
  if MYSQL_PWD="$OPSLOG_BACKUP_PASSWORD" mysql --host="${OPSLOG_BACKUP_HOST:-mysql}" --port="${OPSLOG_BACKUP_PORT:-3306}" \
    --user="${OPSLOG_BACKUP_USER:-opslog_backup}" --protocol=TCP --execute='SELECT 1' >/dev/null 2>&1; then
    exec "$here/backup.sh" run
  fi
  sleep 5
done
echo '{"level":"error","msg":"backup_mysql_unavailable"}' >&2
exit 1
