-- Repair Prisma P1010: "User was denied access on the database `nwords`" (or missing DML on tables).
-- Replace every `nwords` role name below if DATABASE_URL uses a different PostgreSQL user.
--
-- Part A — run while connected to database `postgres` (or any DB you can open as the RDS master user):
ALTER DATABASE nwords OWNER TO nwords;
GRANT CONNECT ON DATABASE nwords TO nwords;
GRANT ALL PRIVILEGES ON DATABASE nwords TO nwords;

-- Part B — run only while connected to database `nwords` (not `postgres`, or you will grant on the wrong DB):
GRANT USAGE ON SCHEMA public TO nwords;
GRANT CREATE ON SCHEMA public TO nwords;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO nwords;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO nwords;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO nwords;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO nwords;
