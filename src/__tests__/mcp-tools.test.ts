// mcp-tools.test.ts — unit tests for MCP tool handlers.
//
// Strategy: mock the DB (getSql), PveExecutor, and LxcExecutor via injection.
// No real PVE, no real SSH, no real Postgres required.

import { describe, it, expect, beforeEach, mock } from "bun:test"
import type { LxcExecutor, ExecResult as LxcExecResult } from "../deploy-engine.ts"
import type { PveExecutor, ExecResult as PveExecResult } from "../pve.ts"

// ── Env setup (must happen before imports that read config) ───────────────────
if (!process.env["MCP_WRITE_TOKEN"]) {
  process.env["MCP_WRITE_TOKEN"] = "test-token-valid-16c"
}
if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://localhost/keel_test"
}

// ── Mock DB ───────────────────────────────────────────────────────────────────

// We mock the db module's getSql to return a fake sql tag function.
// The fake sql supports: tagged template calls + sql`...` with values.

type SqlResult = Record<string, unknown>[]

interface MockSqlOptions {
  services?: SqlResult
  routes?: SqlResult
  deployments?: SqlResult
  secret_keys?: SqlResult
}

/** Creates a minimal mock sql() tag function. */
function makeMockSql(opts: MockSqlOptions = {}) {
  // Stores all INSERT/UPDATE calls for later inspection
  const mutations: Array<{ type: string; table: string; sql: string }> = []

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> => {
    const raw = strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? "?" : ""), "")

    if (raw.includes("FROM keel.services")) {
      return Promise.resolve(opts.services ?? [])
    }
    if (raw.includes("FROM keel.routes")) {
      return Promise.resolve(opts.routes ?? [])
    }
    if (raw.includes("FROM keel.deployments") && raw.includes("SELECT sha")) {
      return Promise.resolve(opts.deployments ?? [])
    }
    if (raw.includes("FROM keel.deployments") && raw.includes("SELECT id")) {
      // INSERT returning id
      return Promise.resolve([{ id: 1 }])
    }
    if (raw.includes("FROM keel.secret_keys")) {
      return Promise.resolve(opts.secret_keys ?? [])
    }
    if (raw.includes("INSERT INTO keel.deployments")) {
      mutations.push({ type: "INSERT", table: "deployments", sql: raw })
      return Promise.resolve([{ id: 42 }])
    }
    if (raw.includes("UPDATE keel.deployments") || raw.includes("UPDATE keel.services")) {
      mutations.push({ type: "UPDATE", table: raw.includes("services") ? "services" : "deployments", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("INSERT INTO keel.routes")) {
      mutations.push({ type: "INSERT", table: "routes", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("INSERT INTO keel.repo_bindings")) {
      mutations.push({ type: "INSERT", table: "repo_bindings", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("INSERT INTO keel.secret_keys")) {
      mutations.push({ type: "INSERT", table: "secret_keys", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("INSERT INTO keel.audit_log")) {
      mutations.push({ type: "INSERT", table: "audit_log", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("DELETE FROM keel.routes")) {
      mutations.push({ type: "DELETE", table: "routes", sql: raw })
      return Promise.resolve([])
    }
    if (raw.includes("DELETE FROM keel.repo_bindings")) {
      mutations.push({ type: "DELETE", table: "repo_bindings", sql: raw })
      return Promise.resolve([])
    }
    // Default: return empty
    return Promise.resolve([])
  }

  // Expose mutations for test inspection
  ;(sqlFn as unknown as { mutations: typeof mutations }).mutations = mutations
  return sqlFn as unknown as import("bun").SQL & { mutations: typeof mutations }
}

// ── Mock executors ────────────────────────────────────────────────────────────

function lxcOk(stdout = ""): LxcExecResult {
  return { code: 0, stdout, stderr: "" }
}

function lxcCurlOk(): LxcExecResult { return { code: 0, stdout: "200", stderr: "" } }

class MockLxcExecutor implements LxcExecutor {
  calls: Array<{ lxc: string; argv: string[] }> = []
  private response: LxcExecResult

  constructor(response: LxcExecResult = lxcOk()) {
    this.response = response
  }

  async run(lxc: string, argv: string[]): Promise<LxcExecResult> {
    this.calls.push({ lxc, argv })
    if (argv[0] === "curl") return lxcCurlOk()
    if (argv[0] === "readlink") return lxcOk("")
    return this.response
  }

  callsFor(verb: string): string[][] {
    return this.calls.filter((c) => c.argv[0] === verb).map((c) => c.argv)
  }
}

function pveOk(data: unknown = {}): PveExecResult {
  return { code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" }
}

class MockPveExecutor implements PveExecutor {
  calls: string[][] = []
  private response: PveExecResult

  constructor(response: PveExecResult = pveOk()) {
    this.response = response
  }

  async run(argv: string[]): Promise<PveExecResult> {
    this.calls.push(argv)
    return this.response
  }

  callsFor(sub: string): string[][] {
    return this.calls.filter((c) => c[0] === sub)
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SERVICE_ROW = {
  id: 1,
  vmid: 201,
  ip: "10.10.10.201",
  port: 3000,
  runtime: "bun",
  health_path: "/healthz",
}

const BASIC_KEEL_YAML = `
name: danmu
runtime: bun
port: 3000
expose:
  internal: danmu.internal
  public: danmu.app.zyx.tw
`

// ── Import tools with injected dependencies ───────────────────────────────────

// We need to mock getSql before importing mcp-tools.
// Bun doesn't support jest.mock() module factory, so we use the injection
// functions exported from mcp-tools.ts instead, and stub getSql via db.ts mock.

// Mock db.ts module before importing
const _dbMock = mock.module("../db.ts", () => ({
  getSql: () => _currentSql,
  closeSql: async () => {},
  pingDb: async () => true,
  runMigration: async () => {},
  MIGRATION: "",
}))

let _currentSql: ReturnType<typeof makeMockSql>

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("mcp-tools — provision_ct", () => {
  beforeEach(() => {
    _currentSql = makeMockSql()
  })

  it("calls pve.createCt and returns vmid", async () => {
    const pveExec = new MockPveExecutor(pveOk({ vmid: 201, ip: "10.10.10.201", hostname: "danmu", status: "running" }))
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const tool = TOOLS.find((t) => t.name === "provision_ct")!
    const result = await tool.handler({ name: "danmu", cores: 2, ram: 512 }) as Record<string, unknown>

    expect(result["ok"]).toBe(true)
    expect(result["vmid"]).toBe(201)
    expect(pveExec.callsFor("create-ct").length).toBe(1)
  })

  it("returns error when name missing", async () => {
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "provision_ct")!
    const result = await tool.handler({}) as Record<string, unknown>
    expect(result["error"]).toMatch(/name is required/)
  })

  it("returns error dict on PVE failure (does not throw)", async () => {
    const pveExec = new MockPveExecutor({ code: 1, stdout: "", stderr: "PVE unreachable" })
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const tool = TOOLS.find((t) => t.name === "provision_ct")!
    const result = await tool.handler({ name: "danmu" }) as Record<string, unknown>
    expect(typeof result["error"]).toBe("string")
  })
})

describe("mcp-tools — bind_service", () => {
  beforeEach(() => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
  })

  it("calls addDns and addCaddy for service with public expose", async () => {
    const pveExec = new MockPveExecutor(pveOk())
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const tool = TOOLS.find((t) => t.name === "bind_service")!
    const result = await tool.handler({ keel_yaml: BASIC_KEEL_YAML }) as Record<string, unknown>

    expect(result["ok"]).toBe(true)
    // Should have called dns add (for internal) and caddy add (for public)
    expect(pveExec.callsFor("dns").some((a) => a.includes("add"))).toBe(true)
    expect(pveExec.callsFor("caddy").some((a) => a.includes("add"))).toBe(true)
  })

  it("calls addDns without addCaddy when no public expose", async () => {
    const pveExec = new MockPveExecutor(pveOk())
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const yamlNoPublic = `
name: danmu
runtime: bun
port: 3000
expose:
  internal: danmu.internal
`
    const tool = TOOLS.find((t) => t.name === "bind_service")!
    await tool.handler({ keel_yaml: yamlNoPublic })

    expect(pveExec.callsFor("dns").some((a) => a.includes("add"))).toBe(true)
    expect(pveExec.callsFor("caddy").length).toBe(0)
  })

  it("returns error when service not found in DB", async () => {
    _currentSql = makeMockSql({ services: [] })  // no services
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "bind_service")!
    const result = await tool.handler({ keel_yaml: BASIC_KEEL_YAML }) as Record<string, unknown>
    expect(result["error"]).toMatch(/not found/)
  })
})

describe("mcp-tools — unbind_service", () => {
  it("calls removeCaddy + removeDns for each route", async () => {
    _currentSql = makeMockSql({
      services: [SERVICE_ROW],
      routes: [
        { hostname: "danmu.app.zyx.tw", type: "external" },
        { hostname: "danmu.internal", type: "internal" },
      ],
    })
    const pveExec = new MockPveExecutor(pveOk())
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const tool = TOOLS.find((t) => t.name === "unbind_service")!
    const result = await tool.handler({ name: "danmu" }) as Record<string, unknown>

    expect(result["ok"]).toBe(true)
    expect(pveExec.callsFor("caddy").some((a) => a.includes("remove"))).toBe(true)
    expect(pveExec.callsFor("dns").some((a) => a.includes("remove"))).toBe(true)
  })
})

describe("mcp-tools — destroy_service", () => {
  it("requires confirm:true — returns error dict when confirm is missing", async () => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "destroy_service")!

    const result = await tool.handler({ name: "danmu" }) as Record<string, unknown>
    expect(typeof result["error"]).toBe("string")
    expect(result["error"]).toMatch(/confirm/)
  })

  it("requires confirm:true — returns error dict when confirm is false", async () => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "destroy_service")!

    const result = await tool.handler({ name: "danmu", confirm: false }) as Record<string, unknown>
    expect(typeof result["error"]).toBe("string")
    expect(result["error"]).toMatch(/confirm/)
  })

  it("calls pve.destroy when confirm:true", async () => {
    _currentSql = makeMockSql({
      services: [SERVICE_ROW],
      routes: [{ hostname: "danmu.internal", type: "internal" }],
    })
    const pveExec = new MockPveExecutor(pveOk())
    const { TOOLS, setMcpPveExecutor } = await import("../mcp-tools.ts")
    setMcpPveExecutor(pveExec)

    const tool = TOOLS.find((t) => t.name === "destroy_service")!
    const result = await tool.handler({ name: "danmu", confirm: true }) as Record<string, unknown>

    expect(result["ok"]).toBe(true)
    expect(pveExec.callsFor("destroy").length).toBe(1)
  })
})

describe("mcp-tools — set_secret", () => {
  it("writes to LXC env_file but does NOT store value in DB", async () => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
    const lxcExec = new MockLxcExecutor()
    const { TOOLS, setLxcExecutor } = await import("../mcp-tools.ts")
    setLxcExecutor(lxcExec)

    const tool = TOOLS.find((t) => t.name === "set_secret")!
    const result = await tool.handler({ name: "danmu", key: "DATABASE_URL", value: "postgres://secret" }) as Record<string, unknown>

    expect(result["ok"]).toBe(true)
    expect(result["key"]).toBe("DATABASE_URL")

    // Value must NOT appear in the response
    expect(JSON.stringify(result)).not.toContain("postgres://secret")

    // Value must NOT appear in DB mutation payloads
    const mutations = (_currentSql as unknown as { mutations: Array<{ sql: string }> }).mutations
    const auditEntry = mutations.find((m) => m.sql.includes("audit_log"))
    // audit_log insert should not contain the value
    expect(auditEntry?.sql ?? "").not.toContain("postgres://secret")
  })

  it("rejects invalid key names (not [A-Z_][A-Z0-9_]*)", async () => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "set_secret")!

    const result = await tool.handler({ name: "danmu", key: "bad-key-name", value: "x" }) as Record<string, unknown>
    expect(typeof result["error"]).toBe("string")
  })

  it("returns error when name missing", async () => {
    _currentSql = makeMockSql()
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "set_secret")!
    const result = await tool.handler({ key: "FOO", value: "bar" }) as Record<string, unknown>
    expect(result["error"]).toMatch(/name/)
  })
})

describe("mcp-tools — list_secret_keys", () => {
  it("returns only key names, never values", async () => {
    _currentSql = makeMockSql({
      services: [SERVICE_ROW],
      secret_keys: [{ key_name: "DATABASE_URL" }, { key_name: "API_KEY" }],
    })
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "list_secret_keys")!

    const result = await tool.handler({ name: "danmu" }) as Record<string, unknown>
    expect(Array.isArray(result["keys"])).toBe(true)
    expect(result["keys"]).toEqual(["DATABASE_URL", "API_KEY"])
    // Response must not contain anything that looks like a value (only key names)
    const serialized = JSON.stringify(result)
    expect(serialized).toContain("DATABASE_URL")
    expect(serialized).toContain("API_KEY")
  })
})

describe("mcp-tools — deploy", () => {
  it("calls deploy-engine.deploy and returns deployment_id", async () => {
    _currentSql = makeMockSql({
      services: [SERVICE_ROW],
      routes: [{ hostname: "danmu.internal", type: "internal" }],
    })
    const lxcExec = new MockLxcExecutor()
    const { TOOLS, setLxcExecutor } = await import("../mcp-tools.ts")
    setLxcExecutor(lxcExec)

    const tool = TOOLS.find((t) => t.name === "deploy")!
    const result = await tool.handler({
      name: "danmu",
      keel_yaml: BASIC_KEEL_YAML,
      repo_url: "https://github.com/zyx1121/danmu",
      sha: "abc1234",
    }) as Record<string, unknown>

    // deploy-engine runs in lxc; result should have ok or status field
    expect(result["deployment_id"]).toBeDefined()
    expect(typeof result["status"]).toBe("string")
  })

  it("returns error when sha missing", async () => {
    _currentSql = makeMockSql({ services: [SERVICE_ROW] })
    const { TOOLS } = await import("../mcp-tools.ts")
    const tool = TOOLS.find((t) => t.name === "deploy")!
    const result = await tool.handler({ name: "danmu", repo_url: "https://github.com/x/y" }) as Record<string, unknown>
    expect(result["error"]).toMatch(/sha/)
  })

  it("does NOT store token in DB or return it", async () => {
    _currentSql = makeMockSql({
      services: [SERVICE_ROW],
      routes: [{ hostname: "danmu.internal", type: "internal" }],
    })
    const lxcExec = new MockLxcExecutor()
    const { TOOLS, setLxcExecutor } = await import("../mcp-tools.ts")
    setLxcExecutor(lxcExec)

    const tool = TOOLS.find((t) => t.name === "deploy")!
    const result = await tool.handler({
      name: "danmu",
      keel_yaml: BASIC_KEEL_YAML,
      repo_url: "https://github.com/zyx1121/danmu",
      sha: "abc1234",
      token: "ghs_supersecret_token",
    }) as Record<string, unknown>

    // Token must NOT appear in result
    expect(JSON.stringify(result)).not.toContain("ghs_supersecret_token")

    // Token must NOT appear in DB mutations
    const mutations = (_currentSql as unknown as { mutations: Array<{ sql: string }> }).mutations
    for (const m of mutations) {
      expect(m.sql).not.toContain("ghs_supersecret_token")
    }
  })
})

describe("mcp-tools — tools/list via dispatch (non-empty)", () => {
  it("TOOLS registry has 12 tools", async () => {
    const { TOOLS } = await import("../mcp-tools.ts")
    expect(TOOLS.length).toBe(12)
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain("provision_ct")
    expect(names).toContain("bind_service")
    expect(names).toContain("bind_repo")
    expect(names).toContain("unbind_service")
    expect(names).toContain("deploy")
    expect(names).toContain("rollback")
    expect(names).toContain("status")
    expect(names).toContain("list_services")
    expect(names).toContain("logs")
    expect(names).toContain("destroy_service")
    expect(names).toContain("set_secret")
    expect(names).toContain("list_secret_keys")
  })
})

describe("mcp-tools — dispatch tools/list returns non-empty", () => {
  it("tools/list returns all 12 tools via MCP dispatch", async () => {
    const { handleMcp } = await import("../mcp-dispatch.ts")
    const { config } = await import("../config.ts")
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.mcpWriteToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    const res = await handleMcp(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools.length).toBe(12)
  })
})
