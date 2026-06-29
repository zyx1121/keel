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

// GitHub App private key — loaded from disk at startup if path is set.
// [THREAT-I-1] The PEM content is memory-only; never enters DB or logs.
// WHY lazy: at startup we just store the path; github-app.ts loads on demand.
const githubAppPrivateKeyPath = process.env["GITHUB_APP_PRIVATE_KEY_PATH"] ?? "/etc/keel/github-app.pem"

// Load the PEM synchronously if the App is configured (App ID set).
// Missing PEM when App ID is set = fail at first token mint, not at startup.
// This lets the server start even if the pem isn't present yet (bootstrap scenario).
// [THREAT-I-1] stored in closure; not exported as raw string in the config object —
// callers use config.githubAppPrivateKey which is null when not configured.
let _githubAppPrivateKey: string | null = null
const _githubAppId = process.env["GITHUB_APP_ID"] ?? null

if (_githubAppId) {
  try {
    const file = Bun.file(githubAppPrivateKeyPath)
    _githubAppPrivateKey = await file.text()
  } catch {
    // Non-fatal: webhook deploys will fail at token mint time with a clear error.
    // The MCP server itself continues to operate normally.
    console.warn(`[keel] WARN: GITHUB_APP_ID is set but could not read PEM from ${githubAppPrivateKeyPath} — webhook deploys will fail until key is present`)
  }
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

  // WEBHOOK_SECRET — HMAC key for GitHub webhook verification.
  // Not required when webhook is not in use (opt-in), but server does NOT start
  // degraded on this — webhook handler itself fails closed (401) when unset.
  webhookSecret: process.env["WEBHOOK_SECRET"] ?? null,

  // GitHub App integration (V2 — optional; webhook degrades gracefully when absent).
  // [THREAT-I-1] githubAppPrivateKey is memory-only; never enters DB, logs, or API.
  githubAppId: _githubAppId,
  githubAppPrivateKey: _githubAppPrivateKey,
  githubAppPrivateKeyPath,

  // Public URL for keel itself — used to build log_url in GitHub Deployment status.
  // e.g. "https://keel.app.zyx.tw"
  keelPublicUrl: process.env["KEEL_PUBLIC_URL"] ?? null,
} as const
