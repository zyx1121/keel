# keel

A thin CD tool for single-server container deployments. Build once in CI, pull and swap on the server.

## How it works

1. **CI** builds the Docker image, pushes it to GHCR tagged with the git SHA, and optionally SSHes into the server to trigger a deploy.
2. **Server** pulls the new image, stops the old container, starts the new one, polls the health endpoint, and rolls back automatically on failure.

## Service contract

Add two files to your service repo:

```
Dockerfile
keel.yaml
```

`keel.yaml`:
```yaml
image: ghcr.io/owner/app
service: app
health_url: http://localhost:8080/health
health_timeout: 30
env_file: /etc/keel/app.env
runtime: compose          # or: systemd-container
```

`env_file` is host-managed and never committed to the repo.

## CI setup

Add to your service repo's workflow:

```yaml
jobs:
  deploy:
    uses: zyx1121/keel/.github/workflows/keel-build.yml@main
    with:
      app: my-service
      deploy: true          # SSH deploy after push
    secrets: inherit
```

Required secrets (if `deploy: true`):
- `KEEL_HOST` — SSH target, e.g. `user@1.2.3.4`
- `KEEL_SSH_KEY` — private key with access to `KEEL_HOST`

## Server setup

```sh
# Install keel
curl -fsSL https://raw.githubusercontent.com/zyx1121/keel/main/keel \
  -o /usr/local/bin/keel && chmod +x /usr/local/bin/keel

# Authenticate to GHCR (pull access)
echo $GHCR_PAT | docker login ghcr.io -u <username> --password-stdin
```

## CLI

```sh
keel deploy ghcr.io/owner/app:abc1234   # deploy a specific SHA
keel rollback my-service                # re-deploy the previous image
keel status my-service                  # show current/previous/deploy log
```

State is stored at `/var/lib/keel/<service>/`.

## Runtimes

| `runtime:` | Mechanism |
|---|---|
| `compose` | `docker compose up -d --pull never <service>` with `IMAGE=<ref>` env |
| `systemd-container` | Writes `IMAGE=<ref>` drop-in under `/etc/systemd/system/<service>.service.d/` then `systemctl restart` |

## What keel does NOT do

- Multi-server fan-out
- Blue/green deploys
- Secrets injection (use `env_file`)
- Non-container (binary/native) deploys

## License

MIT
