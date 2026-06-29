// deployments.ts — GitHub Deployments API state machine.
//
// Provides: createDeployment(), setDeploymentStatus().
// These are called by the webhook worker to report deploy progress to GitHub.
//
// Security model:
//   - installation token from getInstallationToken() is NEVER logged.
//   - log_token (per-deployment unguessable token for /logs/<id>) is stored
//     in keel.deployments.log_token — it is NOT a secret (it's an opaque ID
//     that gates access to logs for that specific deployment), but it must not
//     be derivable from public info.
//   - [THREAT-I-2] /logs route is gated by log_token — not publicly guessable.

import { getInstallationToken } from "./github-app.ts"

// ── State machine ─────────────────────────────────────────────────────────────

export type GhDeployState = "queued" | "in_progress" | "success" | "failure" | "error" | "inactive"

export interface CreateDeploymentResult {
  id: number     // GitHub Deployment id
}

export interface SetStatusOpts {
  environment?: string
  environment_url?: string
  log_url?: string           // gated URL — [THREAT-I-2]
  description?: string
  auto_inactive?: boolean
}

// ── GitHub API calls ──────────────────────────────────────────────────────────

/**
 * Create a GitHub Deployment for the given repo + SHA.
 * Returns the GitHub deployment id.
 * [THREAT-I-1] token not logged.
 */
export async function createDeployment(
  repo: string,          // "owner/name"
  sha: string,
  installationId: number,
  opts: {
    environment?: string
    description?: string
  } = {},
): Promise<number> {
  const token = await getInstallationToken(installationId)  // [THREAT-I-1] not logged

  const resp = await fetch(`https://api.github.com/repos/${repo}/deployments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,  // [THREAT-I-1] not logged
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "keel/0.2.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: sha,
      environment: opts.environment ?? "production",
      description: opts.description ?? "keel deploy",
      auto_merge: false,
      required_contexts: [],   // skip status checks — keel controls the deploy
      transient_environment: false,
      production_environment: true,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`GitHub createDeployment failed (${resp.status}): ${body.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { id?: number }
  if (!data.id) throw new Error("GitHub createDeployment response missing 'id'")
  return data.id
}

/**
 * Set a GitHub Deployment status (queued → in_progress → success / failure).
 * [THREAT-I-1] token not logged.
 */
export async function setDeploymentStatus(
  repo: string,
  githubDeployId: number,
  state: GhDeployState,
  installationId: number,
  opts: SetStatusOpts = {},
): Promise<void> {
  const token = await getInstallationToken(installationId)  // [THREAT-I-1] not logged

  const body: Record<string, unknown> = {
    state,
    ...(opts.environment ? { environment: opts.environment } : {}),
    ...(opts.environment_url ? { environment_url: opts.environment_url } : {}),
    ...(opts.log_url ? { log_url: opts.log_url } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.auto_inactive !== undefined ? { auto_inactive: opts.auto_inactive } : {}),
  }

  const resp = await fetch(
    `https://api.github.com/repos/${repo}/deployments/${githubDeployId}/statuses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,  // [THREAT-I-1] not logged
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "keel/0.2.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  )

  if (!resp.ok) {
    const respBody = await resp.text()
    throw new Error(`GitHub setDeploymentStatus failed (${resp.status}): ${respBody.slice(0, 300)}`)
  }
}
