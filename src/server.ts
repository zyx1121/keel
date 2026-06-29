import { config } from "./config.ts"
import { handleMcp } from "./mcp-dispatch.ts"
import { pingDb, runMigration, getSql } from "./db.ts"
import { handleWebhook } from "./webhook.ts"

async function main() {
  console.log("[keel] starting...")

  // Attempt migration; log error but don't exit — DB may be unreachable during
  // local dev / bootstrap. Health endpoint will report degraded.
  try {
    await runMigration()
    console.log("[keel] migration ok")
  } catch (err) {
    console.error("[keel] migration failed (DB unreachable? will run degraded):", err)
  }

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      // /healthz — open, no auth. DB unreachable → degraded but server stays up.
      if (path === "/healthz" && req.method === "GET") {
        const dbOk = await pingDb()
        return Response.json(
          { status: dbOk ? "ok" : "degraded", db: dbOk, webhook: config.webhookSecret ? "configured" : "unconfigured" },
          { status: 200 } // always 200 — server itself is alive; db state in body
        )
      }

      // /mcp — bearer-gated MCP JSON-RPC endpoint
      if (path === config.mcpPath) {
        return handleMcp(req)
      }

      // /webhook — GitHub App webhook receiver (HMAC-gated, V2)
      if (path === "/webhook") {
        return handleWebhook(req)
      }

      // /logs/<deployment_id> — per-deployment log viewer.
      // [THREAT-I-2] gated by unguessable log_token query param.
      // WHY bearer-OR-token: /logs is linked from GitHub Deployment status;
      // GitHub doesn't send the MCP bearer, so we use a per-deployment token instead.
      const logsMatch = path.match(/^\/logs\/(\d+)$/)
      if (logsMatch && req.method === "GET") {
        const deploymentId = parseInt(logsMatch[1]!, 10)
        const presented = url.searchParams.get("token") ?? req.headers.get("Authorization")?.replace("Bearer ", "")

        if (!presented) {
          return new Response("Unauthorized", { status: 401 })
        }

        try {
          const sql = getSql()
          const rows = await sql<{ log_token: string | null; sha: string; status: string; triggered_by: string; started_at: string | null; finished_at: string | null }[]>`
            SELECT log_token, sha, status, triggered_by, started_at, finished_at
            FROM keel.deployments
            WHERE id = ${deploymentId}
            LIMIT 1
          `
          const row = rows[0]
          if (!row) return new Response("Not Found", { status: 404 })

          // [THREAT-I-2] Validate token — timingSafeEqual to prevent oracle
          if (!row.log_token) return new Response("Unauthorized", { status: 401 })

          const { timingSafeEqual: tse, createHash } = await import("node:crypto")
          const ha = createHash("sha256").update(presented).digest()
          const hb = createHash("sha256").update(row.log_token).digest()
          if (!tse(ha, hb)) return new Response("Unauthorized", { status: 401 })

          return Response.json({
            deployment_id: deploymentId,
            sha: row.sha,
            status: row.status,
            triggered_by: row.triggered_by,
            started_at: row.started_at,
            finished_at: row.finished_at,
          })
        } catch (e) {
          return new Response("Internal Server Error", { status: 500 })
        }
      }

      return new Response("not found", { status: 404 })
    },
  })

  console.log(`[keel] listening on :${server.port}`)
  console.log(`[keel] MCP: POST ${config.mcpPath}`)
  console.log(`[keel] health: GET /healthz`)
  console.log(`[keel] webhook: POST /webhook (HMAC-gated)`)
  console.log(`[keel] logs: GET /logs/<id>?token=<log_token> (per-deployment gated)`)
}

main()
