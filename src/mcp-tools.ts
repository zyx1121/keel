// mcp-tools.ts — MCP tool registry (V1.5).
//
// Each ToolDef.handler:
//   - accepts Record<string, unknown> (dispatched from mcp-dispatch.ts)
//   - returns a JSON-serializable result dict on success
//   - returns { error: string } on any failure (never throws)
//   - writes an audit_log row for every infra-mutating action
//
// Security model:
//   - All infra calls go through pve.ts (fixed typed functions, no arbitrary argv).
//   - Secret values never enter DB, response, or log.
//   - destroy_service requires confirm:true.

import type { ToolDef } from "./mcp-dispatch.ts"
import type { LxcExecutor } from "./deploy-engine.ts"
import type { PveExecutor } from "./pve.ts"
import { deploy, rollback, SshLxcExecutor } from "./deploy-engine.ts"
import { parseKeelConfig } from "./contract.ts"
import { getSql } from "./db.ts"
import {
  createCt as pveCreateCt,
  destroy as pveDestroy,
  addDns,
  removeDns,
  addCaddy,
  removeCaddy,
  status as pveStatus,
  getPveExecutor,
} from "./pve.ts"

// ── Executor injection (for testing) ──────────────────────────────────────────

let _lxcExec: LxcExecutor | null = null
let _pveExec: PveExecutor | null = null

export function setLxcExecutor(e: LxcExecutor): void { _lxcExec = e }
export function setMcpPveExecutor(e: PveExecutor): void { _pveExec = e }
export function getLxcExecutor(): LxcExecutor { return _lxcExec ?? new SshLxcExecutor() }
export function getMcpPveExecutor(): PveExecutor { return _pveExec ?? getPveExecutor() }

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function auditLog(
  serviceId: number | null,
  action: string,
  payload: Record<string, unknown>,
  actor = "agent",
): Promise<void> {
  const sql = getSql()
  await sql`
    INSERT INTO keel.audit_log (service_id, actor, action, payload)
    VALUES (${serviceId}, ${actor}, ${action}, ${JSON.stringify(payload)})
  `
}

async function getServiceByName(name: string): Promise<{
  id: number; vmid: number; ip: string; port: number; runtime: string; health_path: string
} | null> {
  const sql = getSql()
  const rows = await sql<{ id: number; vmid: number; ip: string; port: number; runtime: string; health_path: string }[]>`
    SELECT id, vmid, ip, port, runtime, health_path
    FROM keel.services
    WHERE name = ${name}
    LIMIT 1
  `
  return rows[0] ?? null
}

// ── Tool handlers ──────────────────────────────────────────────────────────────

// 1. provision_ct
async function handleProvisionCt(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name || typeof name !== "string") return { error: "name is required" }

  const opts = {
    cores: typeof args["cores"] === "number" ? args["cores"] : undefined,
    ram: typeof args["ram"] === "number" ? args["ram"] : undefined,
    disk: typeof args["disk"] === "number" ? args["disk"] : undefined,
  }

  try {
    const ct = await pveCreateCt(name, opts, getMcpPveExecutor())
    // Register the provisioned LXC as a service row so bind_service/deploy can find
    // it (they look up by name). port is a placeholder (0) until bind_service sets
    // it from keel.yaml. ON CONFLICT keeps provision idempotent.
    const sql = getSql()
    await sql`
      INSERT INTO keel.services (name, vmid, ip, port, status)
      VALUES (${name}, ${ct.vmid}, ${ct.ip}, 0, 'provisioned')
      ON CONFLICT (name) DO UPDATE SET vmid = EXCLUDED.vmid, ip = EXCLUDED.ip, updated_at = now()
    `
    await auditLog(null, "provision_ct", { name, vmid: ct.vmid, ip: ct.ip })
    return { ok: true, vmid: ct.vmid, ip: ct.ip, name: ct.name, status: ct.status }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 2. bind_service
async function handleBindService(args: Record<string, unknown>): Promise<unknown> {
  const keelYaml = args["keel_yaml"] as string | undefined
  const inlineArgs = args as {
    name?: string
    lxc?: string
    port?: number
    repo_url?: string
    runtime?: string
    health_path?: string
    expose?: { internal?: string; public?: string }
  }

  let config
  let svcName: string
  let port: number
  let repoUrl: string | undefined
  let lxcAlias: string
  let exposeInternal: string
  let exposePublic: string | undefined

  if (keelYaml) {
    try {
      config = parseKeelConfig(keelYaml)
    } catch (e) {
      return { error: `keel_yaml parse error: ${(e as Error).message}` }
    }
    svcName = config.name
    port = config.port
    lxcAlias = `${svcName}-lxc`
    exposeInternal = config.expose.internal
    exposePublic = config.expose.public
  } else {
    svcName = inlineArgs.name ?? ""
    port = inlineArgs.port ?? 0
    lxcAlias = inlineArgs.lxc ?? `${svcName}-lxc`
    exposeInternal = inlineArgs.expose?.internal ?? ""
    exposePublic = inlineArgs.expose?.public
    repoUrl = inlineArgs.repo_url
  }

  if (!svcName) return { error: "name is required (via keel_yaml or name field)" }
  if (!port) return { error: "port is required" }
  if (!exposeInternal) return { error: "expose.internal is required" }

  const sql = getSql()

  // Look up service by name to get vmid/ip
  const existing = await getServiceByName(svcName)
  if (!existing) return { error: `service '${svcName}' not found in DB — run provision_ct first` }

  const pveExec = getMcpPveExecutor()

  try {
    // Wire DNS for internal hostname
    await addDns(exposeInternal, existing.ip, pveExec)

    // Wire Caddy for public hostname if specified
    if (exposePublic) {
      const upstream = `${existing.ip}:${port}`
      await addCaddy(exposePublic, upstream, {}, pveExec)
    }

    // Record route(s) in DB
    await sql`
      INSERT INTO keel.routes (service_id, hostname, type)
      VALUES (${existing.id}, ${exposeInternal}, 'internal')
      ON CONFLICT (hostname) DO NOTHING
    `
    if (exposePublic) {
      await sql`
        INSERT INTO keel.routes (service_id, hostname, type)
        VALUES (${existing.id}, ${exposePublic}, 'external')
        ON CONFLICT (hostname) DO NOTHING
      `
    }

    // Record repo binding if provided
    if (repoUrl) {
      const repoFull = repoUrl.replace("https://github.com/", "")
      const storedYaml = keelYaml ?? null
      const branch = typeof args["branch"] === "string" ? args["branch"] : "main"
      await sql`
        INSERT INTO keel.repo_bindings (service_id, repo_full, default_branch, keel_yaml)
        VALUES (${existing.id}, ${repoFull}, ${branch}, ${storedYaml})
        ON CONFLICT (repo_full) DO UPDATE
          SET keel_yaml = EXCLUDED.keel_yaml,
              default_branch = EXCLUDED.default_branch
      `
    } else if (config?.name) {
      // keel.yaml was provided but no explicit repo_url — skip binding (V2 adds via bind_repo)
    }

    // Update service port/health in DB
    await sql`
      UPDATE keel.services
      SET port = ${port}, status = 'active', updated_at = now()
      WHERE id = ${existing.id}
    `

    await auditLog(existing.id, "bind_service", {
      internal: exposeInternal,
      public: exposePublic ?? null,
      port,
    })

    return { ok: true, name: svcName, internal: exposeInternal, public: exposePublic ?? null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 3. unbind_service
async function handleUnbindService(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()
  const pveExec = getMcpPveExecutor()

  try {
    // Get all routes for this service
    const routes = await sql<{ hostname: string; type: string }[]>`
      SELECT hostname, type FROM keel.routes WHERE service_id = ${existing.id}
    `

    for (const route of routes) {
      if (route.type === "external") {
        await removeCaddy(route.hostname, pveExec)
      } else {
        await removeDns(route.hostname, pveExec)
      }
    }

    // Remove routes from DB (NOT the LXC — unbind != destroy)
    await sql`DELETE FROM keel.routes WHERE service_id = ${existing.id}`

    await sql`
      UPDATE keel.services SET status = 'unbound', updated_at = now()
      WHERE id = ${existing.id}
    `

    await auditLog(existing.id, "unbind_service", { name })
    return { ok: true, name, routes_removed: routes.length }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 4. deploy
async function handleDeploy(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const repoUrl = args["repo_url"] as string | undefined
  const sha = args["sha"] as string | undefined
  const branch = args["branch"] as string | undefined
  const token = args["token"] as string | undefined  // never stored, never logged
  const keelYaml = args["keel_yaml"] as string | undefined

  if (!sha) return { error: "sha is required" }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()

  // Resolve keel.yaml: inline or reconstruct minimal config from DB
  let config
  if (keelYaml) {
    try {
      config = parseKeelConfig(keelYaml)
    } catch (e) {
      return { error: `keel_yaml parse error: ${(e as Error).message}` }
    }
  } else {
    // Reconstruct minimal config from DB service row + required args
    if (!repoUrl) return { error: "repo_url is required when keel_yaml not provided" }
    const internalRoute = await sql<{ hostname: string }[]>`
      SELECT hostname FROM keel.routes
      WHERE service_id = ${existing.id} AND type = 'internal'
      LIMIT 1
    `
    const internalHost = internalRoute[0]?.hostname ?? `${name}.internal`
    const healthPath = existing.health_path ?? "/healthz"

    const minimalYaml = [
      `name: ${name}`,
      `runtime: ${existing.runtime}`,
      `port: ${existing.port}`,
      `expose:`,
      `  internal: ${internalHost}`,
    ].join("\n")
    try {
      config = parseKeelConfig(minimalYaml)
    } catch (e) {
      return { error: `could not reconstruct config from DB: ${(e as Error).message}` }
    }
    // Override health url from DB
    config = {
      ...config,
      health: { url: `http://localhost:${existing.port}${healthPath}`, timeout: 30 },
    }
  }

  const lxcAlias = `${name}-lxc`
  const effectiveRepoUrl = repoUrl ?? (keelYaml ? "https://github.com/placeholder/placeholder" : "")
  if (!effectiveRepoUrl) return { error: "repo_url is required" }

  // Record deployment in DB
  const [depRow] = await sql<{ id: number }[]>`
    INSERT INTO keel.deployments (service_id, sha, triggered_by, status, started_at)
    VALUES (${existing.id}, ${sha}, 'manual', 'in_progress', now())
    RETURNING id
  `
  const deploymentId = depRow!.id

  try {
    const result = await deploy(
      config,
      { lxc: lxcAlias, sha, repoUrl: effectiveRepoUrl, cloneToken: token, branch },
      getLxcExecutor(),
    )

    const dbStatus =
      result.status === "success" ? "success" :
      result.status === "rolled_back" ? "rolled_back" : "failure"

    await sql`
      UPDATE keel.deployments
      SET status = ${dbStatus}, previous_sha = ${result.previousSha ?? null}, finished_at = now()
      WHERE id = ${deploymentId}
    `
    if (result.status === "success") {
      await sql`
        UPDATE keel.services SET status = 'active', updated_at = now()
        WHERE id = ${existing.id}
      `
    }

    await auditLog(existing.id, "deploy", {
      sha,
      deployment_id: deploymentId,
      status: dbStatus,
      previous_sha: result.previousSha,
    })

    return {
      ok: result.status === "success",
      status: result.status,
      sha: result.sha,
      previous_sha: result.previousSha,
      rolled_back_to: result.rolledBackTo,
      deployment_id: deploymentId,
      log_tail: result.log.slice(-10),
    }
  } catch (e) {
    await sql`
      UPDATE keel.deployments
      SET status = 'failure', finished_at = now()
      WHERE id = ${deploymentId}
    `
    return { error: (e as Error).message }
  }
}

// 5. rollback
async function handleRollback(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const toSha = args["to_sha"] as string | undefined
  const keelYaml = args["keel_yaml"] as string | undefined

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()

  let config
  if (keelYaml) {
    try {
      config = parseKeelConfig(keelYaml)
    } catch (e) {
      return { error: `keel_yaml parse error: ${(e as Error).message}` }
    }
  } else {
    const internalRoute = await sql<{ hostname: string }[]>`
      SELECT hostname FROM keel.routes
      WHERE service_id = ${existing.id} AND type = 'internal'
      LIMIT 1
    `
    const internalHost = internalRoute[0]?.hostname ?? `${name}.internal`
    const healthPath = existing.health_path ?? "/healthz"
    const minimalYaml = [
      `name: ${name}`,
      `runtime: ${existing.runtime}`,
      `port: ${existing.port}`,
      `expose:`,
      `  internal: ${internalHost}`,
    ].join("\n")
    try {
      config = parseKeelConfig(minimalYaml)
    } catch (e) {
      return { error: `could not reconstruct config from DB: ${(e as Error).message}` }
    }
    config = {
      ...config,
      health: { url: `http://localhost:${existing.port}${healthPath}`, timeout: 30 },
    }
  }

  const lxcAlias = `${name}-lxc`

  const [depRow] = await sql<{ id: number }[]>`
    INSERT INTO keel.deployments (service_id, sha, triggered_by, status, started_at)
    VALUES (${existing.id}, ${toSha ?? 'rollback'}, 'manual', 'in_progress', now())
    RETURNING id
  `
  const deploymentId = depRow!.id

  try {
    const result = await rollback(
      config,
      { lxc: lxcAlias, toSha },
      getLxcExecutor(),
    )

    const dbStatus = result.status === "rolled_back" ? "rolled_back" : "failure"

    await sql`
      UPDATE keel.deployments
      SET status = ${dbStatus}, finished_at = now()
      WHERE id = ${deploymentId}
    `

    await auditLog(existing.id, "rollback", {
      to_sha: toSha ?? "previous",
      deployment_id: deploymentId,
      status: dbStatus,
      rolled_back_to: result.rolledBackTo,
    })

    return {
      ok: result.status === "rolled_back",
      status: result.status,
      sha: result.sha,
      rolled_back_to: result.rolledBackTo,
      deployment_id: deploymentId,
      log_tail: result.log.slice(-10),
    }
  } catch (e) {
    await sql`
      UPDATE keel.deployments
      SET status = 'failure', finished_at = now()
      WHERE id = ${deploymentId}
    `
    return { error: (e as Error).message }
  }
}

// 6. status
async function handleStatus(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()
  const pveExec = getMcpPveExecutor()

  try {
    const liveStatus = await pveStatus(String(existing.vmid), pveExec)

    const latest = await sql<{ sha: string; status: string; finished_at: string | null }[]>`
      SELECT sha, status, finished_at
      FROM keel.deployments
      WHERE service_id = ${existing.id}
      ORDER BY created_at DESC
      LIMIT 1
    `

    const routes = await sql<{ hostname: string; type: string }[]>`
      SELECT hostname, type FROM keel.routes WHERE service_id = ${existing.id}
    `

    return {
      name,
      vmid: existing.vmid,
      ip: existing.ip,
      port: existing.port,
      db_status: existing,
      live_status: liveStatus.status,
      latest_deployment: latest[0] ?? null,
      routes,
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 7. list_services
async function handleListServices(_args: Record<string, unknown>): Promise<unknown> {
  const sql = getSql()
  try {
    const rows = await sql<{
      id: number; name: string; vmid: number; ip: string; port: number;
      runtime: string; status: string; created_at: string
    }[]>`
      SELECT id, name, vmid, ip, port, runtime, status, created_at
      FROM keel.services
      ORDER BY created_at DESC
    `

    // Attach latest deployment sha for each service
    const result = await Promise.all(rows.map(async (svc) => {
      const latest = await sql<{ sha: string; status: string }[]>`
        SELECT sha, status FROM keel.deployments
        WHERE service_id = ${svc.id}
        ORDER BY created_at DESC
        LIMIT 1
      `
      return { ...svc, current_sha: latest[0]?.sha ?? null, deploy_status: latest[0]?.status ?? null }
    }))

    return { services: result, count: result.length }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 8. logs
async function handleLogs(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const tail = typeof args["tail"] === "number" ? args["tail"] : 50
  const deploymentId = args["deployment_id"] as number | undefined

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()

  // Read deployment log from DB via the deployments table log_token (V2 adds file serving)
  // V1: return last N deployments as log entries
  const condition = deploymentId
    ? sql`WHERE service_id = ${existing.id} AND id = ${deploymentId}`
    : sql`WHERE service_id = ${existing.id}`

  try {
    const rows = await sql<{
      id: number; sha: string; status: string; triggered_by: string;
      started_at: string | null; finished_at: string | null
    }[]>`
      SELECT id, sha, status, triggered_by, started_at, finished_at
      FROM keel.deployments
      ${condition}
      ORDER BY created_at DESC
      LIMIT ${tail}
    `
    return { name, deployments: rows }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 9. destroy_service
async function handleDestroyService(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  const confirm = args["confirm"]

  if (!name) return { error: "name is required" }

  // [THREAT-E-1] Hard guard: confirm must be boolean true
  if (confirm !== true) {
    return { error: "destroy_service requires confirm:true — this is destructive and irreversible" }
  }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()
  const pveExec = getMcpPveExecutor()

  try {
    // Cascade-remove all routes first
    const routes = await sql<{ hostname: string; type: string }[]>`
      SELECT hostname, type FROM keel.routes WHERE service_id = ${existing.id}
    `
    for (const route of routes) {
      if (route.type === "external") {
        await removeCaddy(route.hostname, pveExec).catch(() => { /* best-effort */ })
      } else {
        await removeDns(route.hostname, pveExec).catch(() => { /* best-effort */ })
      }
    }

    // Destroy the LXC (cascade: stops container, removes iptables, DNS)
    await pveDestroy(name, pveExec)

    // Mark service destroyed in DB (keep history — don't delete rows)
    await sql`
      UPDATE keel.services SET status = 'destroyed', updated_at = now()
      WHERE id = ${existing.id}
    `
    await sql`DELETE FROM keel.routes WHERE service_id = ${existing.id}`
    await sql`DELETE FROM keel.repo_bindings WHERE service_id = ${existing.id}`

    await auditLog(existing.id, "destroy_service", { name, vmid: existing.vmid })

    return { ok: true, name, vmid: existing.vmid, destroyed: true }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 10. set_secret
async function handleSetSecret(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  const key = args["key"] as string | undefined
  const value = args["value"] as string | undefined  // [THREAT-I-1] NEVER stored/logged/returned

  if (!name) return { error: "name is required" }
  if (!key || typeof key !== "string") return { error: "key is required" }
  if (value === undefined || typeof value !== "string") return { error: "value is required" }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  // [THREAT-I-1] Validate key name is safe (env var name pattern)
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return { error: "key must match ^[A-Z_][A-Z0-9_]*$ (valid env var name)" }
  }

  const sql = getSql()
  const lxcExec = getLxcExecutor()
  const lxcAlias = `${name}-lxc`
  const envFilePath = `/etc/keel/${name}.env`

  try {
    // Write value to LXC env_file via executor.
    // Replaces any existing KEY= line in the file, then appends the new KEY=value.
    // WHY sh -c: we need a pipeline (grep + printf > tmpfile + mv) that can't be
    // expressed as a single argv element. The key is pre-validated [A-Z_][A-Z0-9_]*
    // (no shell metacharacters). The value is single-quoted with internal quotes
    // escaped via the '\'' idiom — same pattern as shellQuote() in deploy-engine.ts.
    // [ACCEPTED-RISK] V1: value traverses SSH channel as part of the quoted argv
    // string — appears in SSH debug logs but NOT in the env_file on disk unquoted.
    // TODO(security): V2 uses sops-encrypt + scp to avoid value touching SSH argv at all.
    const sanitizedKey = key  // pre-validated [A-Z_][A-Z0-9_]*
    const escapedValue = value.replace(/'/g, `'\\''`)

    const writeRes = await lxcExec.run(lxcAlias, [
      "sh", "-c",
      `touch ${envFilePath} && chmod 600 ${envFilePath} && `
      + `{ grep -v "^${sanitizedKey}=" ${envFilePath} 2>/dev/null || true; printf '${sanitizedKey}=%s\\n' '${escapedValue}'; } > ${envFilePath}.new && mv ${envFilePath}.new ${envFilePath}`,
    ])

    if (writeRes.code !== 0) {
      return { error: `failed to write secret to LXC: ${writeRes.stderr.trim()}` }
    }

    // [THREAT-I-1] Only store key NAME in DB — never value
    await sql`
      INSERT INTO keel.secret_keys (service_id, key_name)
      VALUES (${existing.id}, ${key})
      ON CONFLICT (service_id, key_name) DO NOTHING
    `

    // Audit: log key name only, NEVER value
    await auditLog(existing.id, "set_secret", { key_name: key })

    return { ok: true, name, key }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 11. list_secret_keys
async function handleListSecretKeys(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  if (!name) return { error: "name is required" }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found` }

  const sql = getSql()

  try {
    const rows = await sql<{ key_name: string }[]>`
      SELECT key_name FROM keel.secret_keys
      WHERE service_id = ${existing.id}
      ORDER BY key_name
    `
    // [THREAT-I-1] Return key names only — values NEVER returned
    return { name, keys: rows.map((r) => r.key_name) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// 12. bind_repo — V2: persist full keel.yaml + repo metadata for webhook auto-deploy
async function handleBindRepo(args: Record<string, unknown>): Promise<unknown> {
  const name = args["name"] as string | undefined
  const repo = args["repo"] as string | undefined          // "owner/name"
  const branch = (args["branch"] as string | undefined) ?? "main"
  const installationId = args["installation_id"] as number | undefined
  const keelYaml = args["keel_yaml"] as string | undefined

  if (!name) return { error: "name is required" }
  if (!repo) return { error: "repo is required (owner/name format)" }
  if (!keelYaml) return { error: "keel_yaml is required for webhook auto-deploy" }
  if (!installationId || typeof installationId !== "number") return { error: "installation_id is required (GitHub App installation id)" }

  // Validate keel_yaml is parseable
  let parsedConfig
  try {
    parsedConfig = parseKeelConfig(keelYaml)
  } catch (e) {
    return { error: `keel_yaml parse error: ${(e as Error).message}` }
  }
  if (parsedConfig.name !== name) {
    return { error: `keel_yaml name '${parsedConfig.name}' must match service name '${name}'` }
  }

  const existing = await getServiceByName(name)
  if (!existing) return { error: `service '${name}' not found — run provision_ct first` }

  const sql = getSql()
  try {
    await sql`
      INSERT INTO keel.repo_bindings (service_id, repo_full, default_branch, keel_yaml, installation_id)
      VALUES (${existing.id}, ${repo}, ${branch}, ${keelYaml}, ${installationId})
      ON CONFLICT (repo_full) DO UPDATE
        SET default_branch  = EXCLUDED.default_branch,
            keel_yaml        = EXCLUDED.keel_yaml,
            installation_id  = EXCLUDED.installation_id
    `

    await auditLog(existing.id, "bind_repo", {
      repo,
      branch,
      installation_id: installationId,
      // keel_yaml stored; not logged here to keep audit payload small
    })

    return {
      ok: true,
      name,
      repo,
      branch,
      installation_id: installationId,
      port: parsedConfig.port,
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Tool registry ──────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: "provision_ct",
    description: "Provision a new LXC container for a service (2xx VMID range, unprivileged)",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Service name (hostname-safe: ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$)",
        },
        cores: { type: "number", description: "CPU cores (default: 1)" },
        ram: { type: "number", description: "RAM in MiB (default: 256)" },
        disk: { type: "number", description: "Disk in GiB (default: 8)" },
      },
      required: ["name"],
    },
    handler: handleProvisionCt,
  },
  {
    name: "bind_service",
    description: "Wire DNS + Caddy for a service and record binding in DB. Provide keel_yaml string or individual fields.",
    inputSchema: {
      type: "object",
      properties: {
        keel_yaml: { type: "string", description: "Full keel.yaml content (preferred)" },
        name: { type: "string", description: "Service name (if not using keel_yaml)" },
        lxc: { type: "string", description: "LXC SSH alias (default: <name>-lxc)" },
        port: { type: "number", description: "Service port" },
        repo_url: { type: "string", description: "GitHub repo URL (optional, for binding)" },
        expose: {
          type: "object",
          properties: {
            internal: { type: "string", description: "Internal hostname (e.g. danmu.internal)" },
            public: { type: "string", description: "Public hostname (e.g. danmu.app.zyx.tw)" },
          },
        },
      },
      required: [],
    },
    handler: handleBindService,
  },
  {
    name: "unbind_service",
    description: "Remove Caddy + DNS routes for a service (does NOT destroy the LXC)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
      },
      required: ["name"],
    },
    handler: handleUnbindService,
  },
  {
    name: "deploy",
    description: "Deploy a git SHA to a service's LXC (Capistrano-style: clone → build → swap → health-poll → rollback on failure)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
        repo_url: { type: "string", description: "GitHub repo URL (required if keel_yaml not provided)" },
        sha: { type: "string", description: "Git SHA to deploy (7-40 hex chars)" },
        branch: { type: "string", description: "Branch name (default: main)" },
        token: { type: "string", description: "GitHub access token for private repos (not stored)" },
        keel_yaml: { type: "string", description: "keel.yaml content (if not already bound)" },
      },
      required: ["name", "sha"],
    },
    handler: handleDeploy,
  },
  {
    name: "rollback",
    description: "Roll back a service to a previous SHA (or the recorded previous SHA if to_sha omitted)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
        to_sha: { type: "string", description: "Target SHA to roll back to (omit to use recorded previous)" },
        keel_yaml: { type: "string", description: "keel.yaml content (if not already bound)" },
      },
      required: ["name"],
    },
    handler: handleRollback,
  },
  {
    name: "status",
    description: "Get live PVE status + DB state + latest deployment for a service",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
      },
      required: ["name"],
    },
    handler: handleStatus,
  },
  {
    name: "list_services",
    description: "List all services with their current deployment SHA and status",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: handleListServices,
  },
  {
    name: "logs",
    description: "Return recent deployment history for a service",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
        deployment_id: { type: "number", description: "Filter to specific deployment (optional)" },
        tail: { type: "number", description: "Number of deployments to return (default: 50)" },
      },
      required: ["name"],
    },
    handler: handleLogs,
  },
  {
    name: "destroy_service",
    description: "Permanently destroy a service: removes LXC, DNS, Caddy, DB routes. IRREVERSIBLE. Requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
        confirm: { type: "boolean", description: "Must be true to proceed (safety gate)" },
      },
      required: ["name", "confirm"],
    },
    handler: handleDestroyService,
  },
  {
    name: "set_secret",
    description: "Write a secret key=value to the service LXC env_file. Value is written to LXC only — never stored in DB or returned.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
        key: { type: "string", description: "Env var name ([A-Z_][A-Z0-9_]*)" },
        value: { type: "string", description: "Secret value (written to LXC, never stored/returned)" },
      },
      required: ["name", "key", "value"],
    },
    handler: handleSetSecret,
  },
  {
    name: "list_secret_keys",
    description: "List the env var KEY NAMES stored for a service (values are never returned)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" },
      },
      required: ["name"],
    },
    handler: handleListSecretKeys,
  },
  {
    name: "bind_repo",
    description: "Bind a GitHub repo to a service for webhook auto-deploy (V2). Stores keel.yaml + installation_id so a git push triggers automatic deploy without inline keel_yaml.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (must already exist via provision_ct)" },
        repo: { type: "string", description: "GitHub repo in owner/name format (e.g. zyx1121/danmu)" },
        branch: { type: "string", description: "Branch to watch (default: main)" },
        installation_id: { type: "number", description: "GitHub App installation id (from GitHub App settings)" },
        keel_yaml: { type: "string", description: "Full keel.yaml content to use for this repo/branch" },
      },
      required: ["name", "repo", "installation_id", "keel_yaml"],
    },
    handler: handleBindRepo,
  },
]
