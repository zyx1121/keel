# keel V1.6 Bootstrap

Run `install.sh` inside the keel LXC as root. Steps you must do manually are listed below.

## What install.sh does

1. Installs git, curl, postgresql via apt.
2. Installs Bun (official installer).
3. Creates `keel` database + `keel_app` role in PostgreSQL.
4. Clones/updates the keel repo to `/opt/keel` and runs `bun install`.
5. Runs the DB migration (`src/db.ts:runMigration()`).
6. Applies table grants: `keel_app` gets full CRUD on operational tables, INSERT-only on `audit_log`.
7. Writes `/etc/systemd/system/keel.service` and enables it.

## Manual steps (checklist for operator)

- [ ] **Create keel LXC** — via `utils pve create-ct keel --vmid <N> --cores 2 --ram 512 --disk 16 -y`
- [ ] **Place SSH private key** — copy keel's dedicated keypair into the LXC at `~root/.ssh/id_ed25519`
- [ ] **Configure ~/.ssh/config** in the LXC:
  ```
  Host pve-keel
    HostName 10.10.10.1        # PVE host internal IP
    User root
    Port 1121
    IdentityFile ~/.ssh/id_ed25519
    BatchMode yes
  ```
- [ ] **Forced-command on PVE** — add to PVE's `/root/.ssh/authorized_keys`:
  ```
  command="utils pve $SSH_ORIGINAL_COMMAND",no-pty,no-port-forwarding,no-X11-forwarding <pubkey>
  ```
  This restricts keel's SSH key to running `utils pve` only — not a root shell.
- [ ] **Firewall** — allow port 8080 from the internal network only; block public access until Caddy reverse-proxy is configured.
- [ ] **Place secrets** — copy `keel.env.example` to `/etc/keel/keel.env`, fill in values, `chmod 600 /etc/keel/keel.env`.
- [ ] **Run install.sh** — `bash bootstrap/install.sh` (requires DATABASE_URL in env or `/etc/keel/keel.env` already present for migration step).
- [ ] **Start service** — `systemctl start keel && systemctl status keel`
- [ ] **Verify health** — `curl http://localhost:8080/healthz`
- [ ] **DNS + Caddy** — run `utils pve dns keel.internal <LXC_IP> --action add -y` and `utils pve caddy keel.app.zyx.tw <LXC_IP>:8080 --action add -y` on PVE.

## Notes

- `install.sh` is idempotent: safe to re-run on updates (git reset --hard + re-migrate).
- Secrets never enter the repo. `keel.env` is gitignored.
- `audit_log` append-only grant is enforced at the DB level — `keel_app` cannot UPDATE or DELETE audit rows.
