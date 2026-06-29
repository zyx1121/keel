import { config } from "./config.ts"
import { handleMcp } from "./mcp-dispatch.ts"
import { pingDb, runMigration } from "./db.ts"

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
          { status: dbOk ? "ok" : "degraded", db: dbOk },
          { status: 200 } // always 200 — server itself is alive; db state in body
        )
      }

      // /mcp — bearer-gated MCP JSON-RPC endpoint
      if (path === config.mcpPath) {
        return handleMcp(req)
      }

      // /webhook — stub; implemented in V2 (GitHub App + HMAC signature verification)
      if (path === "/webhook") {
        return new Response("Not Implemented: webhook receiver is V2", { status: 501 })
      }

      return new Response("not found", { status: 404 })
    },
  })

  console.log(`[keel] listening on :${server.port}`)
  console.log(`[keel] MCP: POST ${config.mcpPath}`)
  console.log(`[keel] health: GET /healthz`)
  console.log(`[keel] webhook: stub (501) — V2`)
}

main()
