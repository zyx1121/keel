// webhook.ts — GitHub webhook receiver (push events only).
//
// Security model:
//   - [THREAT-T-1] HMAC-SHA256 verified over RAW body bytes BEFORE JSON.parse.
//     timingSafeEqual prevents timing oracle. Verification fail → 401, body discarded.
//   - [THREAT-D-1] Per-service serial queue with coalesce: a new push for the
//     same service while a deploy is in flight replaces the pending entry.
//     Prevents parallel deploys for the same service and bounded queue depth.
//   - [THREAT-S-2] Webhook only acts on repos with a keel.repo_bindings row —
//     unknown repos silently return 204 (no info disclosure).
//   - Installation token is obtained JIT in worker, never cached in queue.
//   - [THREAT-I-1] No token in logs — worker calls getInstallationToken() and
//     passes it directly to deploy(); the token string is never assigned to a
//     named variable that appears in log output.
//
// WHY 202 + async queue: GitHub times out webhook deliveries at 10s. Deploy can
// take minutes. We ack immediately and process in the background.
// WHY coalesce not append: if two commits push in quick succession, only deploying
// the latest HEAD is correct; deploying stale SHAs wastes builds and could
// regress a service.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { config } from "./config.ts"
import { getSql } from "./db.ts"
import { getInstallationToken } from "./github-app.ts"
import { createDeployment, setDeploymentStatus } from "./deployments.ts"
import { deploy } from "./deploy-engine.ts"
import { SshLxcExecutor } from "./deploy-engine.ts"
import { parseKeelConfig } from "./contract.ts"
import { randomBytes } from "node:crypto"

// ── HMAC verification ─────────────────────────────────────────────────────────

/**
 * Verify X-Hub-Signature-256 header against raw body.
 * [THREAT-T-1] Uses timingSafeEqual over fixed-length digests.
 * Returns true only if WEBHOOK_SECRET is configured AND signature matches.
 *
 * WHY read from process.env directly (not config): config is frozen at module
 * load time. In test environments, WEBHOOK_SECRET may be set after the config
 * module is first imported. Reading from env at call time is also correct for
 * production (secret rotation without restart is a bonus).
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env["WEBHOOK_SECRET"] ?? config.webhookSecret
  if (!secret) return false  // fail-closed: no secret = no webhook

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false

  const presented = signatureHeader.slice("sha256=".length)

  // [THREAT-T-1] HMAC-SHA256: keyed hash, not a plain hash of secret+body
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")

  // Compare as fixed-length hex strings via timingSafeEqual
  // (both 64 hex chars = 32 bytes when decoded — no length side-channel)
  if (presented.length !== expected.length) return false

  return timingSafeEqual(
    Buffer.from(presented, "hex"),
    Buffer.from(expected, "hex"),
  )
}

// ── Push event payload shape ──────────────────────────────────────────────────

export interface PushPayload {
  ref: string           // "refs/heads/main"
  after: string         // HEAD SHA after push
  repository: {
    full_name: string   // "owner/repo"
    clone_url: string   // https clone URL
  }
  pusher: { name: string }
  installation?: { id: number }
}

function parsePushPayload(body: string): PushPayload | null {
  try {
    return JSON.parse(body) as PushPayload
  } catch {
    return null
  }
}

function branchFromRef(ref: string): string | null {
  const prefix = "refs/heads/"
  if (!ref.startsWith(prefix)) return null
  return ref.slice(prefix.length)
}

// ── Per-service serial deploy queue (coalescing) ──────────────────────────────
//
// Invariant: at most one entry pending per service.
// A new push for the same service replaces the pending entry (coalesce).
// The worker runs serially per service — no parallel deploys.

interface QueueEntry {
  serviceId: number
  serviceName: string
  repo: string          // "owner/name"
  sha: string
  branch: string
  installationId: number
  cloneUrl: string
}

// serviceId → pending entry (coalescing: replace on new push)
const _pending = new Map<number, QueueEntry>()
// serviceId → "busy" flag (worker running)
const _busy = new Set<number>()

/** Exposed for testing. */
export function getPendingCount(): number { return _pending.size }
export function getBusyCount(): number { return _busy.size }

/** Enqueue a push event. Coalesces: replaces any existing pending entry. */
export function enqueueWebhookDeploy(entry: QueueEntry): void {
  _pending.set(entry.serviceId, entry)
  if (!_busy.has(entry.serviceId)) {
    drainQueue(entry.serviceId)
  }
  // If busy: worker will pick up the coalesced entry when it finishes current deploy
}

/** Worker: drain pending entries for a service sequentially. */
async function drainQueue(serviceId: number): Promise<void> {
  while (_pending.has(serviceId)) {
    const entry = _pending.get(serviceId)!
    _pending.delete(serviceId)
    _busy.add(serviceId)

    try {
      await runWebhookDeploy(entry)
    } catch (e) {
      // runWebhookDeploy is already wrapped — this catch is defense in depth
      console.error(`[webhook] deploy worker error for service ${entry.serviceName}:`, (e as Error).message)
    } finally {
      _busy.delete(serviceId)
    }
  }
}

// ── Deploy worker ─────────────────────────────────────────────────────────────

/** Generate a cryptographically random unguessable log token. */
function generateLogToken(): string {
  return randomBytes(32).toString("hex")
}

async function runWebhookDeploy(entry: QueueEntry): Promise<void> {
  const sql = getSql()
  const { serviceId, serviceName, repo, sha, branch, installationId, cloneUrl } = entry

  // Insert keel deployment row
  const logToken = generateLogToken()
  const [depRow] = await sql<{ id: number }[]>`
    INSERT INTO keel.deployments (service_id, sha, triggered_by, status, log_token, started_at)
    VALUES (${serviceId}, ${sha}, 'webhook', 'queued', ${logToken}, now())
    RETURNING id
  `
  const keelDeployId = depRow!.id

  // Create GitHub Deployment (queued)
  let githubDeployId: number | null = null
  try {
    githubDeployId = await createDeployment(repo, sha, installationId, {
      description: `keel webhook deploy ${sha.slice(0, 7)}`,
    })
    await sql`
      UPDATE keel.deployments
      SET github_deploy_id = ${githubDeployId}, status = 'in_progress'
      WHERE id = ${keelDeployId}
    `
    await setDeploymentStatus(repo, githubDeployId, "in_progress", installationId, {
      description: "keel: build in progress",
    })
  } catch (e) {
    // GitHub API failure is non-fatal — proceed with deploy, just log
    console.error(`[webhook] GitHub Deployment API error:`, (e as Error).message)
  }

  // Fetch keel.yaml from DB binding
  const bindings = await sql<{
    keel_yaml: string | null
    branch: string
  }[]>`
    SELECT keel_yaml, default_branch AS branch
    FROM keel.repo_bindings
    WHERE service_id = ${serviceId} AND repo_full = ${repo}
    LIMIT 1
  `
  const binding = bindings[0]

  if (!binding?.keel_yaml) {
    const msg = `[webhook] no keel_yaml in binding for ${repo} service=${serviceName}`
    console.error(msg)
    await sql`
      UPDATE keel.deployments SET status = 'failure', finished_at = now()
      WHERE id = ${keelDeployId}
    `
    if (githubDeployId !== null) {
      await setDeploymentStatus(repo, githubDeployId, "failure", installationId, {
        description: "keel: no keel_yaml in binding",
      }).catch(() => {})
    }
    return
  }

  let keelConfig
  try {
    keelConfig = parseKeelConfig(binding.keel_yaml)
  } catch (e) {
    const msg = `keel.yaml parse error: ${(e as Error).message}`
    console.error(`[webhook] ${msg}`)
    await sql`
      UPDATE keel.deployments SET status = 'failure', finished_at = now()
      WHERE id = ${keelDeployId}
    `
    if (githubDeployId !== null) {
      await setDeploymentStatus(repo, githubDeployId, "failure", installationId, {
        description: `keel: ${msg}`,
      }).catch(() => {})
    }
    return
  }

  // Mint installation token for clone — [THREAT-I-1] not assigned to logged var
  let deployResult
  try {
    const cloneToken = await getInstallationToken(installationId)  // [THREAT-I-1] not logged
    const lxcExec = new SshLxcExecutor()
    deployResult = await deploy(
      keelConfig,
      {
        lxc: `${serviceName}-lxc`,
        sha,
        repoUrl: cloneUrl.replace("https://", "https://"),  // preserved as-is; token embedded below
        cloneToken,  // [THREAT-I-1] embed into URL inside deploy(), never logged
        branch,
      },
      lxcExec,
    )
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[webhook] deploy() threw:`, msg)
    await sql`
      UPDATE keel.deployments SET status = 'failure', finished_at = now()
      WHERE id = ${keelDeployId}
    `
    if (githubDeployId !== null) {
      await setDeploymentStatus(repo, githubDeployId, "failure", installationId, {
        description: `keel: deploy error: ${msg.slice(0, 140)}`,
      }).catch(() => {})
    }
    return
  }

  const dbStatus =
    deployResult.status === "success" ? "success" :
    deployResult.status === "rolled_back" ? "rolled_back" : "failure"

  await sql`
    UPDATE keel.deployments
    SET status = ${dbStatus}, previous_sha = ${deployResult.previousSha ?? null}, finished_at = now()
    WHERE id = ${keelDeployId}
  `
  if (deployResult.status === "success") {
    await sql`
      UPDATE keel.services SET status = 'active', updated_at = now()
      WHERE id = ${serviceId}
    `
  }

  // GitHub status
  if (githubDeployId !== null) {
    const ghState = deployResult.status === "success" ? "success" : "failure"
    const logUrl = config.keelPublicUrl
      ? `${config.keelPublicUrl}/logs/${keelDeployId}?token=${logToken}`
      : undefined

    // Get public URL from routes
    const publicRoute = await sql<{ hostname: string }[]>`
      SELECT hostname FROM keel.routes
      WHERE service_id = ${serviceId} AND type = 'external'
      LIMIT 1
    `
    const envUrl = publicRoute[0]?.hostname
      ? `https://${publicRoute[0].hostname}`
      : undefined

    await setDeploymentStatus(repo, githubDeployId, ghState, installationId, {
      description:
        deployResult.status === "success"
          ? `keel: deployed ${sha.slice(0, 7)} successfully`
          : `keel: deploy failed (status=${deployResult.status})`,
      environment_url: ghState === "success" ? envUrl : undefined,
      log_url: logUrl,
    }).catch((e) => {
      console.error(`[webhook] GitHub setStatus final error:`, (e as Error).message)
    })
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

/**
 * Handle POST /webhook.
 *
 * [THREAT-T-1] Verifies HMAC over raw body before parsing JSON.
 * Returns 202 immediately after enqueuing; deploy runs in background.
 */
export async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  // [THREAT-T-1] Read raw body FIRST — never parse before verifying
  const rawBody = await req.text()

  const signature = req.headers.get("X-Hub-Signature-256")
  if (!verifyWebhookSignature(rawBody, signature)) {
    // [THREAT-I-2] Don't reveal whether secret is configured or what failed
    return new Response("Unauthorized", { status: 401 })
  }

  const event = req.headers.get("X-GitHub-Event")

  // Only handle push events — ignore others silently
  if (event !== "push") {
    return new Response(null, { status: 204 })
  }

  const payload = parsePushPayload(rawBody)
  if (!payload) {
    return new Response("Bad Request: invalid JSON", { status: 400 })
  }

  const branch = branchFromRef(payload.ref)
  if (!branch) {
    // Non-branch push (e.g. tag) — ignore
    return new Response(null, { status: 204 })
  }

  const repo = payload.repository.full_name
  const sha = payload.after

  // Validate SHA format (security: used in path construction by deploy-engine)
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return new Response("Bad Request: invalid sha", { status: 400 })
  }

  const installationId = payload.installation?.id
  if (!installationId) {
    // Push from a repo not installed via GitHub App — cannot get token
    return new Response(null, { status: 204 })
  }

  // Look up repo_binding (repo + branch)
  const sql = getSql()
  const bindings = await sql<{
    service_id: number
    service_name: string
    clone_url: string
  }[]>`
    SELECT rb.service_id, s.name AS service_name, ${payload.repository.clone_url} AS clone_url
    FROM keel.repo_bindings rb
    JOIN keel.services s ON s.id = rb.service_id
    WHERE rb.repo_full = ${repo}
      AND rb.default_branch = ${branch}
    LIMIT 1
  `

  if (!bindings[0]) {
    // [THREAT-S-2] No binding for this repo+branch — silently ignore (204)
    return new Response(null, { status: 204 })
  }

  const binding = bindings[0]

  enqueueWebhookDeploy({
    serviceId: binding.service_id,
    serviceName: binding.service_name,
    repo,
    sha,
    branch,
    installationId,
    cloneUrl: payload.repository.clone_url,
  })

  return new Response(null, { status: 202 })
}
