import { describe, it, expect, beforeAll } from "bun:test"

// config.ts reads MCP_WRITE_TOKEN at module evaluation time.
// We read the token back from config after it's loaded to avoid token mismatch
// when CI env and local test env differ.

beforeAll(() => {
  if (!process.env["MCP_WRITE_TOKEN"]) {
    process.env["MCP_WRITE_TOKEN"] = "test-token-valid-16c"
  }
  if (!process.env["DATABASE_URL"]) {
    process.env["DATABASE_URL"] = "postgres://localhost/keel_test"
  }
})

async function getToken(): Promise<string> {
  const { config } = await import("../config.ts")
  return config.mcpWriteToken
}

describe("mcp-dispatch", () => {
  it("initialize returns serverInfo with name=keel", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const token = await getToken()
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    const res = await handleMcp(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe("keel")
  })

  it("tools/list returns empty array (stub)", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const token = await getToken()
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
    const res = await handleMcp(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(Array.isArray(body.result.tools)).toBe(true)
    expect(body.result.tools.length).toBe(0)
  })

  it("rejects request without bearer token (401)", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }),
    })
    const res = await handleMcp(req)
    expect(res.status).toBe(401)
  })

  it("notifications/initialized returns 204 no content", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const token = await getToken()
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    const res = await handleMcp(req)
    expect(res.status).toBe(204)
  })

  it("unknown method returns -32601 method not found", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const token = await getToken()
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nope/nope" }),
    })
    const res = await handleMcp(req)
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })
})
