#!/usr/bin/env bash
# bootstrap/install.sh — idempotent keel LXC bootstrap
# Run as root inside the keel LXC.
# Does NOT write any secrets — env values must be placed manually at /etc/keel/keel.env.
#
# NOTE: This script is verified with `bash -n` (syntax only).
#       Full end-to-end validation requires a real LXC+PG environment (待真機驗).
set -euo pipefail

REPO_URL="https://github.com/zyx1121/keel.git"
INSTALL_DIR="/opt/keel"
ENV_DIR="/etc/keel"
SERVICE_NAME="keel"

# ── 1. System packages ─────────────────────────────────────────────────────────

apt-get update -qq
apt-get install -y -qq git curl unzip postgresql postgresql-contrib

# ── 2. Bun (official installer, idempotent) ────────────────────────────────────

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

# Make bun available for the rest of this script (installer puts it in ~/.bun/bin)
export PATH="${HOME}/.bun/bin:${PATH}"

# ── 3. PostgreSQL — database + role (scram password on loopback) ───────────────

systemctl enable postgresql
systemctl start postgresql

# Source env early: KEEL_DB_PASSWORD + DATABASE_URL drive role + migration.
if [ -f "${ENV_DIR}/keel.env" ]; then
  set -a; source "${ENV_DIR}/keel.env"; set +a
fi
: "${KEEL_DB_PASSWORD:?set KEEL_DB_PASSWORD in ${ENV_DIR}/keel.env before running}"

# Role (idempotent) with password — authenticates via scram on the default
# loopback pg_hba rule (no pg_hba edit needed). Password is hex (no SQL metachars).
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_app') THEN
    CREATE ROLE keel_app LOGIN PASSWORD '${KEEL_DB_PASSWORD}';
  ELSE
    ALTER ROLE keel_app PASSWORD '${KEEL_DB_PASSWORD}';
  END IF;
END\$\$;
SQL

# Database (idempotent — CREATE DATABASE can't sit inside a DO block).
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='keel'" | grep -q 1; then
  sudo -u postgres createdb -O keel_app keel
fi

# ── 4. Clone / update repo ────────────────────────────────────────────────────

if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch origin
  git -C "${INSTALL_DIR}" reset --hard origin/main
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
bun install --frozen-lockfile

# ── 5. DB migration ───────────────────────────────────────────────────────────

# runMigration() is exported from src/db.ts.
# We invoke it via a tiny inline script so we don't need a separate entrypoint.
# DATABASE_URL must already be present in the env at this point (sourced below or in shell).
if [ -f "${ENV_DIR}/keel.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "${ENV_DIR}/keel.env"; set +a
fi

bun -e "
import { runMigration } from './src/db.ts';
await runMigration();
console.log('migration ok');
"

# ── 6. audit_log append-only grant ────────────────────────────────────────────
# keel_app gets INSERT only on audit_log (no UPDATE/DELETE).
# Full table grants for operational tables are also applied here so the role
# is ready before the service starts.

sudo -u postgres psql -d keel -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA keel TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON keel.services        TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON keel.repo_bindings   TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON keel.routes          TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON keel.deployments     TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON keel.secret_keys     TO keel_app;
-- Enforce append-only: reassign audit_log to postgres FIRST, THEN grant INSERT.
-- Order matters: a GRANT to a table's own owner is a no-op (owner privileges are
-- implicit, no ACL entry), so granting while keel_app still owned audit_log left
-- it with nothing after the owner change. Reassign, then grant on the now-foreign
-- table. id is a sequence default (not identity), so INSERT also needs sequence USAGE.
ALTER TABLE keel.audit_log OWNER TO postgres;
GRANT INSERT ON keel.audit_log TO keel_app;
GRANT USAGE ON SEQUENCE keel.audit_log_id_seq TO keel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA keel GRANT USAGE ON SEQUENCES TO keel_app;
SQL

# ── 7. Env directory ──────────────────────────────────────────────────────────

mkdir -p "${ENV_DIR}"
chmod 750 "${ENV_DIR}"
# Actual secrets are placed manually by the operator — see bootstrap/keel.env.example.

# ── 8. systemd service ────────────────────────────────────────────────────────

cat > /etc/systemd/system/keel.service <<EOF
[Unit]
Description=keel orchestrator
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_DIR}/keel.env
ExecStart=${HOME}/.bun/bin/bun run start
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo ""
echo "Bootstrap complete."
echo "Place secrets at ${ENV_DIR}/keel.env (see bootstrap/keel.env.example),"
echo "then: systemctl start keel"
