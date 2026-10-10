-- 016. Creates the least-privilege login used by the CRM API on a fresh Docker database.
-- psql variables app_user and app_password are supplied by docker/init/001-create-app-role.sh.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user') \gexec
