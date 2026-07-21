```
██╗  ██╗███████╗███████╗██╗
██║ ██╔╝██╔════╝██╔════╝██║
█████╔╝ █████╗  █████╗  ██║
██╔═██╗ ██╔══╝  ██╔══╝  ██║
██║  ██╗███████╗███████╗███████╗
╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝
```

# keel

> Push to main. keel provisions the LXC, builds it, wires DNS and Caddy, and tells GitHub how it went. No Docker, no k8s, no clicking around Proxmox.

`proxmox` · `lxc` · `mcp` · `git-driven-cd` · `bun`

[![CI](https://github.com/zyx1121/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/zyx1121/keel/actions) &nbsp;[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzyx1121%2Fkeel%2Fmain%2Fpackage.json&query=%24.version&label=version&color=111111)](package.json) &nbsp;[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

```
$ git push origin main
  → GitHub webhook (HMAC) → keel /webhook
  ⚡ deploy { name: "danmu", sha: "f8a3c1e" }
✓ clone → build → symlink swap → health OK (9s)
✓ GitHub Deployment: success
```

<sub>Push, and keel deploys danmu.internal + danmu.app.zyx.tw the Vercel way, on a Proxmox box you already own.</sub>

Every new service used to mean the same manual crawl: spin up an LXC by hand, wire dnsmasq and Caddy, ssh in for a `git pull` and a restart. keel folds that into one push (or one MCP tool call), the same shape as Vercel but landing on LXCs instead of someone else's cloud.

## Quickstart (dev)

```sh
export MCP_WRITE_TOKEN=<token-min-16-chars>
export DATABASE_URL=postgres://localhost/keel

bun install
bun run dev
```

```sh
curl http://localhost:8080/healthz
# {"status":"ok","db":true,"webhook":"unconfigured"}
```

## What it gives you

- **Provisions and wires networking on demand**: `provision_ct` plus `bind_service` / `bind_repo` spin up an LXC and register DNS + Caddy + webhook auto-deploy in one call.
- **Deploys Capistrano-style**: git SHA → clone → build → symlink swap → health poll, with auto-rollback on failure and a GitHub Deployment status update on every push.
- **Tears down safely**: `destroy_service` requires `confirm: true` and cascades Caddy, DNS, DB rows, and the LXC together.

## Architecture

```
agent --MCP(bearer)--> keel /mcp
GitHub --webhook(HMAC)--> keel /webhook
   │
   ▼  push → repo↔service binding → deploy queue
keel LXC (2xx)
   │  ssh(forced-command) → utils pve {create-ct,dns,caddy,forward,destroy,status}
   │  ssh(target LXC)     → git pull + build → symlink swap → systemctl restart
   ▼
GitHub Deployments API ← queued/in_progress/success/failure
```

Bun + TypeScript, hand-rolled JSON-RPC 2.0 over `Bun.serve` (no MCP SDK: its `StreamableHTTPServerTransport` expects Node's `res.writeHead`, incompatible with Bun's fetch-based server). Bearer auth is `timingSafeEqual` over sha256, fail-closed. State lives in Postgres (`keel` schema: desired state; live PVE/LXC is runtime truth), and deploys land on unprivileged, no-nesting LXCs, Capistrano-style.

## keel.yaml

A service repo drops this at its root; `bind_repo` and the webhook read it on every push (full annotated version with all defaults in [`keel.yaml.example`](keel.yaml.example)):

```yaml
name: pad-core
runtime: bun
build:
  install: bun install --frozen-lockfile
  command: bun run build
run:
  command: bun run start
port: 8080
health:
  url: http://localhost:8080/healthz
  timeout: 30
expose:
  internal: pad-core.internal
  public: pad-core.app.zyx.tw
```

`runtime` also accepts `node`, `python`, and `static`, each with its own default `build`/`run` commands so most repos need no overrides at all.

## MCP tools

| Tool | Description |
|------|-------------|
| `provision_ct` | Provision a new LXC for a service |
| `bind_service` | Wire DNS + Caddy routes |
| `bind_repo` | Bind a GitHub repo for webhook auto-deploy (V2) |
| `unbind_service` | Remove Caddy + DNS routes (LXC stays) |
| `deploy` | Manual deploy: clone → build → health poll |
| `rollback` | Revert to a previous SHA |
| `status` | Current/previous SHA, health, deploy log tail |
| `list_services` | Enumerate managed services |
| `logs` | Per-deployment log stream |
| `set_secret` | Register a secret key=value (value → LXC env_file, never DB) |
| `list_secret_keys` | List key names for a service |
| `destroy_service` | Cascade destroy (requires `confirm: true`) |

## Security model

- `/mcp` bearer, fail-closed: token unset or under 16 chars aborts startup; `/webhook` HMAC-SHA256 over the raw body, verified before `JSON.parse`
- `/logs/<id>` gated by an unguessable per-deployment token (GitHub can't send the MCP bearer)
- `utils pve` white-list dispatch only, no raw shell execution path
- `build.command` / `build.install` are the one accepted arbitrary-code surface, sandboxed to the target spoke LXC
- Secret values never enter Postgres, API responses, build logs, or git; every mitigation above is tagged inline in source (`THREAT-T-1`, `THREAT-D-1`, ...) for audit

## Roadmap

V1.2 through V2 shipped: MCP scaffold, `keel.yaml` parser, deploy engine, MCP tools, LXC bootstrap, GitHub App + webhook + Deployments API. Next up, V3: migrate existing services off k3s onto keel.

## Contributing

Issues and PRs welcome: start with [CONTRIBUTING.md](https://github.com/zyx1121/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE) · keeps the fleet pointed straight while everyone else pushes to main
