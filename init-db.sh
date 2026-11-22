#!/bin/bash
# Create the app role with restricted permissions
# This runs once when the Postgres container is first initialized
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Create restricted app role (no UPDATE/DELETE on ticket_events)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_app') THEN
      CREATE ROLE frontdesk_app LOGIN PASSWORD 'frontdesk_app_dev';
    END IF;
  END
  \$\$;

  -- Test database for integration tests
  CREATE DATABASE frontdesk_test;
  GRANT ALL PRIVILEGES ON DATABASE frontdesk_test TO frontdesk;
EOSQL
