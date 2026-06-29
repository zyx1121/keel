# keel

git-driven CD orchestrator for LXC-as-service on Proxmox. MCP-driven, Vercel-like.

Agent pushes a repo → keel provisions an LXC, builds inside it, wires DNS + Caddy, and reports deployment status back to GitHub. No Docker. No k8s.

## Architecture

```
agent --MCP(bearer)--> keel /mcp
GitHub --webhook(HMAC)--> keel /webhook  (V2)
   │
   ▼  push → repo↔service binding → deploy queue
keel LXC (2xx)
   │  ssh(forced-command) → utils pve {create-ct,dns,caddy,forward,destroy,status}
   │  ssh(target LXC)     → git pull + build → symlink swap → systemctl restart
   ▼
GitHub Deployments API ← queued/in_progress/success/failure
```

## Stack

- **Runtime**: [Bun](https://bun.sh) + TypeScript, ES modules
- **Transport**: hand-rolled JSON-RPC 2.0 over `Bun.serve` (no SDK — incompatible transport)
- **Auth**: bearer token, `timingSafeEqual` over sha256, fail-closed
- **State**: Postgres (`keel` schema — desired state; live PVE/LXC = runtime truth)
- **Deploy target**: LXC (unprivileged + no-nesting), Capistrano-style releases

## Quick start (dev)

```sh
export MCP_WRITE_TOKEN=<token-min-16-chars>
export DATABASE_URL=postgres://localhost/keel

bun install
bun run dev
```

```sh
# Health
curl http://localhost:8080/healthz

# MCP initialize
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $MCP_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## MCP tools

Tools are a stub in V1.2 (`tools/list` returns `[]`). V1.5 will add:

| Tool | Description |
|------|-------------|
| `provision_ct` | Provision a new LXC for a service |
| `bind_service` | Wire DNS + Caddy routes |
| `unbind_service` | Cascade destroy: caddy/dns/forward/LXC |
| `deploy` | Manual deploy: git pull → build → health poll |
| `rollback` | Revert to previous SHA |
| `status` | Current/previous SHA, health, deploy log tail |
| `list_services` | Enumerate managed services |
| `logs` | Per-deployment log stream |
| `set_secret` | Register a secret key name (value → env_file, never in DB) |
| `list_secret_keys` | List key names for a service |
| `destroy_service` | Cascade destroy (requires `confirm: true`) |

## Security model

- `/mcp` bearer, fail-closed (token unset or < 16 chars → startup abort + 401)
- `/webhook` HMAC over raw body (V2); stub returns 501 now
- `utils pve` white-list dispatch only — no raw shell execution paths
- `build_cmd` is the only arbitrary code execution, sandboxed to the target spoke LXC
- Secret values never enter Postgres, API responses, build logs, or git

## Roadmap

| Milestone | Scope |
|-----------|-------|
| V1.2 | MCP server scaffold (this) |
| V1.3 | `keel.yaml` contract parser |
| V1.4 | Deploy engine (Capistrano-style in-LXC) |
| V1.5 | MCP tools implementation |
| V1.6 | systemd unit + LXC bootstrap |
| V2 | GitHub App + webhook + Deployments API |
| V3 | Migrate existing services; retire k3s |

## License

MIT
