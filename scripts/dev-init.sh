#!/usr/bin/env bash
set -euo pipefail

PGDATA="${PGDATA:-.dev/postgres}"
LOGDIR=".dev/logs"

echo "Initializing yaffle dev environment..."

# Create directories
mkdir -p "$LOGDIR"

# Initialize postgres if needed
if [ ! -d "$PGDATA" ]; then
  echo "Initializing postgres data directory at $PGDATA..."
  initdb -D "$PGDATA" --no-locale -E UTF8

  # Start temporarily to create databases and user
  pg_ctl start -D "$PGDATA" -l "$LOGDIR/postgres-init.log" -o "-k /tmp -p 5432" -w

  echo "Creating databases and user..."
  createdb -h /tmp -p 5432 yaffle_dev
  createdb -h /tmp -p 5432 yaffle_test
  psql -h /tmp -p 5432 -d yaffle_dev -c "CREATE USER yaffle WITH SUPERUSER;" 2>/dev/null || true
  psql -h /tmp -p 5432 -d yaffle_dev -c "GRANT ALL PRIVILEGES ON DATABASE yaffle_dev TO yaffle;"
  psql -h /tmp -p 5432 -d yaffle_dev -c "GRANT ALL PRIVILEGES ON DATABASE yaffle_test TO yaffle;"

  pg_ctl stop -D "$PGDATA" -m fast

  echo "Postgres initialized with yaffle_dev and yaffle_test databases"
else
  echo "Postgres data directory already exists at $PGDATA"
fi

echo ""
echo "Setup complete! Run 'process-compose up' to start services."
