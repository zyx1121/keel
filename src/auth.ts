import { createHash, timingSafeEqual } from "node:crypto"

import { config } from "./config.ts"

// [THREAT-S-1] Constant-time bearer comparison via fixed-length sha256 digests.
// Both operands hash to 32 bytes regardless of input length — no length side-channel.
function tokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

// Fail CLOSED: a missing/short configured token denies EVERY request.
// config.ts already exits if token is unset or < 16 chars — this is defense-in-depth
// for the per-request path (e.g. hot-reload or env mutation during runtime).
export function checkAuth(req: Request): Response | null {
  const required = config.mcpWriteToken
  if (!required || required.length < 16) {
    return new Response("Unauthorized", { status: 401 })
  }

  const authHeader = req.headers.get("Authorization") ?? ""
  const prefix = "Bearer "
  const presented = authHeader.startsWith(prefix)
    ? authHeader.slice(prefix.length)
    : ""

  if (!tokenEqual(presented, required)) {
    return new Response("Unauthorized", { status: 401 })
  }
  return null
}
