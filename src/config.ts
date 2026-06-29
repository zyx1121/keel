// Env-driven config. All required vars fail fast at startup.
// WHY fail fast: a missing token / DB URL means every request would either be
// insecure or broken — better to crash loud than limp silently.

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    console.error(`[keel] FATAL: ${name} is required but not set`)
    process.exit(1)
  }
  return v
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

// Bearer token: enforced >= 16 chars at startup (auth.ts also checks per-request).
const rawToken = process.env["MCP_WRITE_TOKEN"] ?? ""
if (!rawToken || rawToken.length < 16) {
  console.error("[keel] FATAL: MCP_WRITE_TOKEN must be set and >= 16 chars")
  process.exit(1)
}

export const config = {
  port: parseInt(optional("PORT", "8080"), 10),
  mcpPath: optional("MCP_PATH", "/mcp"),
  mcpWriteToken: rawToken,

  // Postgres — accept either a full DATABASE_URL or individual PG* vars.
  // DATABASE_URL wins if both are present.
  pg: {
    url: process.env["DATABASE_URL"] ?? null,
    host: optional("PGHOST", "localhost"),
    port: parseInt(optional("PGPORT", "5432"), 10),
    user: optional("PGUSER", "postgres"),
    password: optional("PGPASSWORD", "postgres"),
    database: optional("PGDATABASE", "keel"),
  },

  // WEBHOOK_SECRET placeholder — used in V2 HMAC webhook verification.
  // Not required at startup for V1 (webhook route returns 501).
  webhookSecret: process.env["WEBHOOK_SECRET"] ?? null,
} as const
