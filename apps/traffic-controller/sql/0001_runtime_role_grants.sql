-- Traffic-controller runtime role bootstrap
--
-- Required psql variables:
--   runtime_role
--   runtime_password
--
-- This script is intended to run with a privileged/admin connection.
-- Do not run it with the traffic-controller runtime role itself.

\if :{?runtime_role}
\else
  \echo 'psql variable runtime_role is required'
  \quit 1
\endif

\if :{?runtime_password}
\else
  \echo 'psql variable runtime_password is required'
  \quit 1
\endif

SELECT set_config('traffic_control.runtime_role', :'runtime_role', false);
SELECT set_config('traffic_control.runtime_password', :'runtime_password', false);

CREATE SCHEMA IF NOT EXISTS traffic_control;

DO $$
DECLARE
  runtime_role text := current_setting('traffic_control.runtime_role');
  runtime_password text := current_setting('traffic_control.runtime_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', runtime_role, runtime_password);
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', runtime_role, runtime_password);
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA traffic_control TO %I', runtime_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA traffic_control TO %I',
    runtime_role
  );
  EXECUTE format(
    'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA traffic_control TO %I',
    runtime_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA traffic_control GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    runtime_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA traffic_control GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
    runtime_role
  );
END
$$;
