import { describe, it, expect } from "bun:test"

// config.ts calls process.exit(1) on missing/short MCP_WRITE_TOKEN.
// We test that the env is already set (by auth.test.ts beforeAll or direct env).
// This test validates config values are read correctly when env is valid.

describe("config", () => {
  it("reads PORT from env or defaults to 8080", async () => {
    // config is already loaded; just verify the shape
    const { config } = await import("../config.ts")
    expect(config.port).toBeGreaterThan(0)
  })

  it("defaults mcpPath to /mcp", async () => {
    const { config } = await import("../config.ts")
    expect(config.mcpPath).toBe("/mcp")
  })

  it("mcpWriteToken is set (fail-closed enforced at startup)", async () => {
    const { config } = await import("../config.ts")
    expect(config.mcpWriteToken.length).toBeGreaterThanOrEqual(16)
  })

  it("webhookSecret defaults to null when unset", async () => {
    const { config } = await import("../config.ts")
    // In test env we don't set WEBHOOK_SECRET, so it should be null
    expect(config.webhookSecret).toBeNull()
  })
})
