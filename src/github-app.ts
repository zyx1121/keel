// github-app.ts — GitHub App JWT minting + installation token management.
//
// Security model:
//   - Private key (PEM) is read once from disk at startup and kept only in memory.
//     It NEVER enters DB, logs, or API responses.
//   - Installation tokens are cached in memory (~1h) keyed by installation_id.
//     Expired tokens are discarded; a fresh token is minted transparently.
//   - JWT uses RS256 with the App private key; exp = 10 minutes (GitHub maximum is 10m).
//   - [THREAT-I-1] Neither the PEM nor any token appears in logged output.
//     callers must not log the return value of getInstallationToken().
//
// WHY no external dependency: Bun ships a built-in `crypto` module (SubtleCrypto)
// with RSA-PKCS1-v1_5 SHA-256 support. We build a minimal JWT signer from it to
// avoid pulling in jsonwebtoken / node-jose and expanding the attack surface.

import { config } from "./config.ts"

// ── JWT (RS256, minimal implementation) ──────────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function jsonB64url(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)))
}

/**
 * Sign a GitHub App JWT using the PEM private key.
 * exp is capped at 10 minutes (GitHub requirement).
 * [THREAT-I-1] The returned token is sensitive — callers must not log it.
 */
export async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    iat: now - 60,   // 60s clock-skew tolerance (GitHub recommends this)
    exp: now + 600,  // 10 minutes (GitHub maximum)
    iss: appId,
  }

  const signingInput = `${jsonB64url(header)}.${jsonB64url(payload)}`

  // Import PEM key for RS256 sign
  // WHY: Bun SubtleCrypto supports RSASSA-PKCS1-v1_5 (RS256) natively.
  const keyData = pemToArrayBuffer(privateKeyPem)
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  )

  return `${signingInput}.${b64url(sigBuf)}`
}

/** Convert PEM-encoded RSA private key to ArrayBuffer (DER). */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem.trim().split("\n")
  // Strip first and last line (-----BEGIN/END PRIVATE KEY-----)
  const b64 = lines
    .filter((l) => !l.startsWith("-----"))
    .join("")
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)!
  }
  return bytes.buffer
}

// ── Installation token cache ──────────────────────────────────────────────────

interface CachedToken {
  token: string        // [THREAT-I-1] never log
  expiresAt: number    // unix epoch seconds
}

// Keyed by installation_id (number as string)
const _tokenCache = new Map<string, CachedToken>()

// Expire tokens 5 minutes before GitHub does, to avoid race conditions.
const TOKEN_EXPIRY_BUFFER_SEC = 300

/**
 * Get a GitHub installation access token for the given installation_id.
 *
 * Mints a new JWT on every call (lightweight — JWT is a signed string, no network),
 * then exchanges it for an installation token via GitHub API.
 * Caches the result for ~55 minutes (GitHub tokens are valid for 1 hour).
 *
 * [THREAT-I-1] The returned token string is sensitive — callers MUST NOT log it.
 */
export async function getInstallationToken(
  installationId: number,
  appId?: string,
  privateKeyPem?: string,
): Promise<string> {
  // Check cache FIRST — allows test injection via injectCachedToken without
  // needing a real App ID / PEM. In production the cache is populated after first mint.
  const cacheKey = String(installationId)
  const cached = _tokenCache.get(cacheKey)
  const now = Math.floor(Date.now() / 1000)

  if (cached && cached.expiresAt - TOKEN_EXPIRY_BUFFER_SEC > now) {
    return cached.token  // [THREAT-I-1] not logged
  }

  // Cache miss — need to mint a new token; App must be configured.
  const effectiveAppId = appId ?? config.githubAppId
  const effectivePem = privateKeyPem ?? config.githubAppPrivateKey

  if (!effectiveAppId || !effectivePem) {
    throw new Error("GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PATH missing)")
  }

  // Mint a fresh JWT and exchange for installation token
  const jwt = await signAppJwt(effectiveAppId, effectivePem)

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,  // [THREAT-I-1] jwt not logged
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "keel/0.2.0",
      },
    },
  )

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`GitHub App token mint failed (${resp.status}): ${body.slice(0, 200)}`)
  }

  const data = (await resp.json()) as { token: string; expires_at: string }
  if (!data.token) {
    throw new Error("GitHub App token response missing 'token' field")
  }

  const expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000)

  // [THREAT-I-1] Cache token in memory only — never DB, never log
  _tokenCache.set(cacheKey, { token: data.token, expiresAt })

  return data.token  // [THREAT-I-1] not logged
}

/** Evict a cached token (e.g. on 401 from GitHub). */
export function evictInstallationToken(installationId: number): void {
  _tokenCache.delete(String(installationId))
}

/** Read the private key PEM from disk. Throws if file unreadable. */
export async function loadPrivateKeyPem(path: string): Promise<string> {
  try {
    const file = Bun.file(path)
    const pem = await file.text()
    if (!pem.includes("PRIVATE KEY")) {
      throw new Error(`File at ${path} does not look like a PEM private key`)
    }
    return pem.trim()
  } catch (e) {
    throw new Error(`Failed to read GitHub App private key from ${path}: ${(e as Error).message}`)
  }
}

/** Clear the token cache (for testing). */
export function clearTokenCache(): void {
  _tokenCache.clear()
}

/**
 * Inject a pre-computed token into the cache (for testing only).
 * WHY: allows tests to bypass JWT signing + HTTP exchange without
 * needing a real RSA key or live GitHub API.
 * [THREAT-I-1] For tests — never call in production paths.
 */
export function injectCachedToken(installationId: number, token: string): void {
  const farFuture = Math.floor(Date.now() / 1000) + 7200
  _tokenCache.set(String(installationId), { token, expiresAt: farFuture })
}
