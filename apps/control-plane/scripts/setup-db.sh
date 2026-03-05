#!/usr/bin/env bash
set -euo pipefail

# Setup script for Yaffle development database
# Usage: ./scripts/setup-db.sh [--reset]

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-yaffle}"
DB_NAME="${DB_NAME:-yaffle_dev}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../drizzle"

reset=false
if [[ "${1:-}" == "--reset" ]]; then
  reset=true
fi

echo "==> Setting up database: $DB_NAME"

if $reset; then
  echo "==> Dropping existing database..."
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
fi

echo "==> Creating database if not exists..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME;" 2>/dev/null || echo "    (database already exists)"

echo "==> Running migrations..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATIONS_DIR/0000_init.sql"

echo "==> Done!"
