-- ============================================================
-- 001_init.sql  –  Frontdesk schema
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('AGENT','MANAGER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('NEW','OPEN','WAITING_ON_CUSTOMER','RESOLVED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_priority AS ENUM ('URGENT','MEDIUM','LOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE msg_visibility AS ENUM ('PUBLIC','INTERNAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE actor_type AS ENUM ('AGENT','CUSTOMER','SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_type AS ENUM (
    'TICKET_CREATED','TICKET_CLAIMED','TICKET_RELEASED',
    'PUBLIC_REPLY','INTERNAL_NOTE',
    'STATUS_CHANGED','PRIORITY_CHANGED',
    'CLOCK_PAUSED','CLOCK_RESUMED',
    'TICKET_REOPENED','TICKET_AUTO_CLOSED','TICKET_CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'AGENT',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Holidays ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holidays (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tickets ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_token         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  subject                TEXT NOT NULL,
  description            TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  customer_email         TEXT NOT NULL,
  priority               ticket_priority NOT NULL DEFAULT 'MEDIUM',
  status                 ticket_status NOT NULL DEFAULT 'NEW',
  assignee_id            UUID REFERENCES users(id),
  version                INTEGER NOT NULL DEFAULT 1,
  parent_ticket_id       UUID REFERENCES tickets(id),

  -- SLA tracking (null while paused)
  response_due_at        TIMESTAMPTZ,
  resolution_due_at      TIMESTAMPTZ,

  -- SLA outcomes (immutable once set)
  first_responded_at     TIMESTAMPTZ,
  first_response_sla_met BOOLEAN,         -- true=met, false=breached, null=pending
  resolved_at            TIMESTAMPTZ,
  resolution_sla_met     BOOLEAN,

  -- Timestamps
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for list queries
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_response_due  ON tickets(response_due_at) WHERE response_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_resolution_due ON tickets(resolution_due_at) WHERE resolution_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_tracking ON tickets(tracking_token);
CREATE INDEX IF NOT EXISTS idx_tickets_created  ON tickets(created_at);

-- ── Messages ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type actor_type NOT NULL,
  author_id   UUID REFERENCES users(id),   -- NULL for CUSTOMER / SYSTEM
  visibility  msg_visibility NOT NULL DEFAULT 'PUBLIC',
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket   ON messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_messages_visibility ON messages(ticket_id, visibility);

-- Customer-facing view: PUBLIC messages only
CREATE OR REPLACE VIEW customer_messages AS
  SELECT id, ticket_id, author_type, author_id, body, created_at
  FROM   messages
  WHERE  visibility = 'PUBLIC';

-- ── Ticket Events (append-only audit log) ────────────────────
CREATE TABLE IF NOT EXISTS ticket_events (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   UUID NOT NULL REFERENCES tickets(id),
  actor       TEXT NOT NULL,              -- agent UUID, 'CUSTOMER', or 'SYSTEM'
  event_type  event_type NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  prev_hash   TEXT NOT NULL DEFAULT '',
  hash        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

-- ── Immutability triggers on ticket_events ───────────────────
CREATE OR REPLACE FUNCTION deny_events_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ticket_events is append-only; mutation is forbidden (operation: %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_deny_events_update    ON ticket_events;
DROP TRIGGER IF EXISTS trg_deny_events_delete    ON ticket_events;
DROP TRIGGER IF EXISTS trg_deny_events_truncate  ON ticket_events;

CREATE TRIGGER trg_deny_events_update
  BEFORE UPDATE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION deny_events_mutation();

CREATE TRIGGER trg_deny_events_delete
  BEFORE DELETE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION deny_events_mutation();

CREATE TRIGGER trg_deny_events_truncate
  BEFORE TRUNCATE ON ticket_events
  FOR EACH STATEMENT EXECUTE FUNCTION deny_events_mutation();

-- ── updated_at trigger for tickets ────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── App role (restricted permissions) ────────────────────────
-- The role is created outside migrations (by docker-compose init or manually).
-- We grant here so it's idempotent if the role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON users, tickets, messages, holidays TO frontdesk_app;
    GRANT SELECT, INSERT ON ticket_events TO frontdesk_app;
    GRANT USAGE, SELECT ON SEQUENCE ticket_events_id_seq TO frontdesk_app;
    GRANT SELECT ON customer_messages TO frontdesk_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON schema_migrations TO frontdesk_app;
    REVOKE UPDATE, DELETE ON ticket_events FROM frontdesk_app;
  END IF;
END $$;
