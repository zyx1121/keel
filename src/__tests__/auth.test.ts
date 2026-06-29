import { describe, it, expect, beforeAll } from "bun:test"

// Tests for bearer auth logic. We exercise checkAuth via mock Requests.
//
// config.ts reads MCP_WRITE_TOKEN at module evaluation time. In CI the workflow
// sets the env var; locally we ensure it here. We read the actual token from
// config so the tests always use the same value config was loaded with.

beforeAll(() => {
  if (!process.env["MCP_WRITE_TOKEN"]) {
    process.env["MCP_WRITE_TOKEN"] = "test-token-valid-16c"
  }
  if (!process.env["DATABASE_URL"]) {
    process.env["DATABASE_URL"] = "postgres://localhost/keel_test"
  }
})

describe("checkAuth", () => {
  it("accepts a valid bearer token", async () => {
    const { checkAuth } = await import("../auth.ts")
    const { config } = await import("../config.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.mcpWriteToken}` },
    })
    const result = checkAuth(req)
    expect(result).toBeNull()
  })

  it("rejects a wrong token", async () => {
    const { checkAuth } = await import("../auth.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer definitely-wrong-token-xyz" },
    })
    const result = checkAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })

  it("rejects a missing Authorization header", async () => {
    const { checkAuth } = await import("../auth.ts")
    const req = new Request("http://localhost/mcp", { method: "POST" })
    const result = checkAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })

  it("rejects a Bearer prefix with empty token", async () => {
    const { checkAuth } = await import("../auth.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " },
    })
    const result = checkAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })
})
