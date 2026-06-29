import { describe, it, expect, beforeAll, afterAll } from "bun:test"

// Tests for bearer auth logic. We import the raw tokenEqual logic via checkAuth
// by constructing mock Requests — this exercises the real code path.
//
// NOTE: config.ts calls process.exit(1) if MCP_WRITE_TOKEN is unset/short.
// We set a valid token before importing any module that pulls in config.

const TEST_TOKEN = "test-token-valid-16c"

beforeAll(() => {
  process.env["MCP_WRITE_TOKEN"] = TEST_TOKEN
  process.env["DATABASE_URL"] = "postgres://localhost/keel_test"
})

afterAll(() => {
  delete process.env["MCP_WRITE_TOKEN"]
  delete process.env["DATABASE_URL"]
})

describe("checkAuth", () => {
  it("accepts a valid bearer token", async () => {
    const { checkAuth } = await import("../auth.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    })
    const result = checkAuth(req)
    expect(result).toBeNull()
  })

  it("rejects a wrong token", async () => {
    const { checkAuth } = await import("../auth.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token-here" },
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
