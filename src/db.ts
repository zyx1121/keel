import type { SQL } from "bun"

import { config } from "./config.ts"
import { splitSqlStatements } from "./sql-split.ts"

// Bun.SQL is the built-in postgres client (Bun 1.1+).
// Prefer DATABASE_URL; fall back to individual PG* vars.
function makeConnectionString(): string {
  if (config.pg.url) return config.pg.url
  const { host, port, user, password, database } = config.pg
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

let _sql: SQL | null = null

export function getSql(): SQL {
  if (!_sql) {
    _sql = new Bun.SQL(makeConnectionString())
  }
  return _sql
}

export async function closeSql() {
  if (_sql) {
    await _sql.end()
    _sql = null
  }
}

// keel schema migration.
// audit_log is append-only by design:
//   TODO(security): after LXC bootstrap, run:
//     CREATE ROLE keel_app;
//     GRANT INSERT ON keel.audit_log TO keel_app;
//     -- Do NOT grant UPDATE or DELETE on audit_log to keel_app.
//     GRANT SELECT, INSERT, UPDATE, DELETE ON keel.services TO keel_app;
//     GRANT SELECT, INSERT, UPDATE, DELETE ON keel.repo_bindings TO keel_app;
//     GRANT SELECT, INSERT, UPDATE, DELETE ON keel.routes TO keel_app;
//     GRANT SELECT, INSERT, UPDATE, DELETE ON keel.deployments TO keel_app;
//     GRANT SELECT, INSERT, UPDATE, DELETE ON keel.secret_keys TO keel_app;
//     ALTER DEFAULT PRIVILEGES IN SCHEMA keel GRANT USAGE ON SEQUENCES TO keel_app;
//   This must be done during V1.6 bootstrap (deploy-time DB role setup).
export const MIGRATION = `
CREATE SCHEMA IF NOT EXISTS keel;

-- services: one row per managed LXC service
CREATE TABLE IF NOT EXISTS keel.services (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  vmid         integer NOT NULL UNIQUE,    -- LXC VMID (2xx range)
  ip           text NOT NULL,              -- 10.10.10.<vmid>
  port         integer NOT NULL,
  runtime      text NOT NULL DEFAULT 'bun',
  health_path  text NOT NULL DEFAULT '/healthz',
  status       text NOT NULL DEFAULT 'provisioning',  -- provisioning/active/failed/destroyed
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- repo_bindings: GitHub repo → service mapping
CREATE TABLE IF NOT EXISTS keel.repo_bindings (
  id              serial PRIMARY KEY,
  service_id      integer NOT NULL REFERENCES keel.services(id),
  repo_full       text NOT NULL UNIQUE,  -- e.g. "zyx1121/danmu"
  default_branch  text NOT NULL DEFAULT 'main',
  -- V2 additions (ALTER TABLE below handles existing tables)
  keel_yaml       text,                  -- stored keel.yaml for webhook auto-deploy
  installation_id bigint,                -- GitHub App installation id
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- routes: external hostname → service routing (Caddy/dnsmasq)
CREATE TABLE IF NOT EXISTS keel.routes (
  id           serial PRIMARY KEY,
  service_id   integer NOT NULL REFERENCES keel.services(id),
  hostname     text NOT NULL UNIQUE,  -- e.g. "mediatek.winlab.tw"
  type         text NOT NULL DEFAULT 'external',  -- external / internal
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- deployments: deploy history per service
CREATE TABLE IF NOT EXISTS keel.deployments (
  id              serial PRIMARY KEY,
  service_id      integer NOT NULL REFERENCES keel.services(id),
  sha             text NOT NULL,
  previous_sha    text,                    -- for rollback
  triggered_by    text NOT NULL DEFAULT 'manual',  -- manual / webhook
  status          text NOT NULL DEFAULT 'queued',  -- queued/in_progress/success/failure/rolled_back
  log_token       text,                    -- unguessable token for /logs/<id> (V2)
  github_deploy_id bigint,                 -- GitHub Deployments API id (V2)
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- secret_keys: only key names are stored — values never enter the DB.
-- Actual secret values live in env_file on the target LXC (managed by sops/scp, V2).
CREATE TABLE IF NOT EXISTS keel.secret_keys (
  id           serial PRIMARY KEY,
  service_id   integer NOT NULL REFERENCES keel.services(id),
  key_name     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, key_name)
);

-- audit_log: append-only event log.
-- DB role keel_app must have INSERT only (no UPDATE/DELETE) — see TODO(security) above.
CREATE TABLE IF NOT EXISTS keel.audit_log (
  id           bigserial PRIMARY KEY,
  service_id   integer REFERENCES keel.services(id),
  actor        text NOT NULL DEFAULT 'system',  -- 'agent', 'webhook', 'system'
  action       text NOT NULL,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS services_name_idx       ON keel.services (name);
CREATE INDEX IF NOT EXISTS deployments_service_idx ON keel.deployments (service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_status_idx  ON keel.deployments (status);
CREATE INDEX IF NOT EXISTS audit_log_service_idx   ON keel.audit_log (service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx    ON keel.audit_log (action);

-- V2 migrations: add columns to existing tables (idempotent via DO $$)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='keel' AND table_name='repo_bindings' AND column_name='keel_yaml') THEN
    ALTER TABLE keel.repo_bindings ADD COLUMN keel_yaml text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='keel' AND table_name='repo_bindings' AND column_name='installation_id') THEN
    ALTER TABLE keel.repo_bindings ADD COLUMN installation_id bigint;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS repo_bindings_repo_branch_idx
  ON keel.repo_bindings (repo_full, default_branch);
`

export async function runMigration() {
  const sql = getSql()
  // $$-aware split — Bun.SQL runs one statement per unsafe() call, but DO blocks
  // must stay intact (see splitSqlStatements).
  for (const stmt of splitSqlStatements(MIGRATION)) {
    await sql.unsafe(stmt)
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    const sql = getSql()
    await sql`SELECT 1`
    return true
  } catch {
    return false
  }
}
