// deploy-engine.test.ts — unit tests using mock executor.
// No real LXC, no SSH, no HTTP — health is mocked via curl argv in executor.

import { describe, it, expect, beforeEach } from "bun:test"
import {
  deploy,
  rollback,
  shellQuote,
  buildRemoteCommand,
  type LxcExecutor,
  type ExecResult,
} from "../deploy-engine.ts"
import type { KeelConfig } from "../contract.ts"
import { parseKeelConfig } from "../contract.ts"

// ── Test helpers ──────────────────────────────────────────────────────────────

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" }
}

function fail(stderr = "mock error"): ExecResult {
  return { code: 1, stdout: "", stderr }
}

/** curl result: 200 = healthy, 0-stdout = curl error (unhealthy). */
function curlOk(): ExecResult   { return { code: 0, stdout: "200", stderr: "" } }
function curlFail(): ExecResult { return { code: 1, stdout: "000", stderr: "connection refused" } }

/**
 * Programmable mock executor.
 * - `responses` maps argv[0] (the command verb) to a result factory.
 * - For "sh" commands, the factory also receives argv[2] (the shell script string)
 *   so tests can distinguish ensureRuntime checks from build steps.
 * - Anything not in the map returns ok().
 * - Use `calls` to inspect what was executed.
 */
class MockExecutor implements LxcExecutor {
  calls: Array<{ lxc: string; argv: string[] }> = []
  private responses: Map<string, ExecResult | ((argv: string[]) => ExecResult)>

  constructor(responses: Record<string, ExecResult | ((argv: string[]) => ExecResult)> = {}) {
    this.responses = new Map(Object.entries(responses))
  }

  async run(lxc: string, argv: string[]): Promise<ExecResult> {
    this.calls.push({ lxc, argv })
    const verb = argv[0] ?? ""
    const entry = this.responses.get(verb)
    if (entry === undefined) return ok()
    return typeof entry === "function" ? entry(argv) : entry
  }

  /** Return all argv arrays where argv[0] === verb. */
  callsFor(verb: string): string[][] {
    return this.calls.filter((c) => c.argv[0] === verb).map((c) => c.argv)
  }
}

/**
 * Programmable curl sequence for health mocking.
 * Each call to the returned factory pops the next response.
 * After exhaustion the last response repeats (so [curlFail] = always fail).
 */
function curlSequence(...results: ExecResult[]): (_argv: string[]) => ExecResult {
  let idx = 0
  return () => {
    const r = results[Math.min(idx, results.length - 1)] ?? curlFail()
    idx++
    return r
  }
}

// ── Shared fixture ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<KeelConfig> = {}): KeelConfig {
  return {
    name: "danmu",
    runtime: "bun",
    repo: { build_path: "." },
    build: { install: "bun install --frozen-lockfile", command: "bun run build" },
    run: { command: "bun run start", working_dir: "/opt/danmu" },
    port: 3000,
    // Keep timeout short (1s) so polls exhaust quickly in unit tests — no real sleeps
    health: { url: "http://localhost:3000/healthz", timeout: 1 },
    env_file: "/etc/keel/danmu.env",
    resources: { cores: 1, ram: 256, disk: 8, swap: 4096 },
    expose: { internal: "danmu.internal" },
    depends_on: [],
    ...overrides,
  }
}

const DEFAULT_OPTS = {
  lxc: "danmu-lxc",
  sha: "abc123def456",
  repoUrl: "https://github.com/zyx1121/danmu",
  branch: "main",
}

// ── Test 0: shellQuote / buildRemoteCommand ───────────────────────────────────
// These are pure functions — no LXC needed.  They guard the SSH quoting fix.

describe("shellQuote", () => {
  it("wraps a simple word in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'")
  })

  it("escapes internal single quotes via the '\\'' idiom", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it("preserves spaces inside quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'")
  })

  it("preserves shell metacharacters literally", () => {
    // None of these should break out of the single-quote context
    expect(shellQuote("a;b&&c|d>e")).toBe("'a;b&&c|d>e'")
  })

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''")
  })
})

describe("buildRemoteCommand", () => {
  it("joins quoted args with spaces", () => {
    expect(buildRemoteCommand(["sh", "-c", "cd /x && bun install"])).toBe(
      "'sh' '-c' 'cd /x && bun install'",
    )
  })

  it("correctly quotes multi-word arg as one shell word", () => {
    // The critical case: sh -c payload must arrive as ONE arg on the remote
    const cmd = buildRemoteCommand(["sh", "-c", "cd /srv/x && bun install --frozen-lockfile"])
    // When the remote shell parses this it sees exactly 3 words: sh, -c, <payload>
    // Verify the payload is a single quoted token with no unquoted spaces
    expect(cmd).toBe("'sh' '-c' 'cd /srv/x && bun install --frozen-lockfile'")
  })
})

// ── Test 1: Happy path ────────────────────────────────────────────────────────

describe("deploy — happy path", () => {
  let exec: MockExecutor

  beforeEach(() => {
    exec = new MockExecutor({
      readlink: ok(""),          // no current symlink yet (first deploy)
      curl: curlOk(),            // health check succeeds immediately
    })
  })

  it("returns status=success", async () => {
    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)
    expect(result.status).toBe("success")
    expect(result.sha).toBe(DEFAULT_OPTS.sha)
  })

  it("calls git clone with correct sha and repoUrl", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec)
    const cloneCalls = exec.callsFor("git")
    expect(cloneCalls.length).toBeGreaterThanOrEqual(1)
    const cloneCall = cloneCalls[0]!
    expect(cloneCall).toContain("clone")
    expect(cloneCall).toContain(DEFAULT_OPTS.repoUrl)
    expect(cloneCall.some((a) => a.includes(DEFAULT_OPTS.sha))).toBe(true)
  })

  it("runs build install and command via sh -c", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec)
    const shCalls = exec.callsFor("sh").map((a) => a.join(" "))
    expect(shCalls.some((c) => c.includes("bun install"))).toBe(true)
    expect(shCalls.some((c) => c.includes("bun run build"))).toBe(true)
  })

  it("calls systemctl restart after swap", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec)
    const restartCalls = exec.callsFor("systemctl")
    expect(restartCalls.some((a) => a.includes("restart"))).toBe(true)
  })

  it("performs atomic symlink swap (mv -Tf)", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec)
    const mvCalls = exec.callsFor("mv")
    expect(mvCalls.some((a) => a.includes("-Tf"))).toBe(true)
  })

  it("embeds clone token in clone URL but not in result.log", async () => {
    const tokenExec = new MockExecutor({ readlink: ok(""), curl: curlOk() })
    const opts = { ...DEFAULT_OPTS, cloneToken: "ghs_test_token" }

    const result = await deploy(makeConfig(), opts, tokenExec)

    const cloneCall = tokenExec.callsFor("git")[0]!.join(" ")
    expect(cloneCall).toContain("x-access-token:ghs_test_token")
    expect(result.log.join("\n")).not.toContain("ghs_test_token")
  })

  it("polls health via curl inside the target LXC (not via fetch)", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec)
    // curl must have been called on the same lxc as the deploy
    const curlCalls = exec.callsFor("curl")
    expect(curlCalls.length).toBeGreaterThanOrEqual(1)
    // The health URL must appear in the curl argv
    expect(curlCalls.some((a) => a.some((p) => p.includes("localhost:3000")))).toBe(true)
    // All curl calls must be on the target lxc
    const allOnTargetLxc = exec.calls
      .filter((c) => c.argv[0] === "curl")
      .every((c) => c.lxc === DEFAULT_OPTS.lxc)
    expect(allOnTargetLxc).toBe(true)
  })
})

// ── Test 2: Build failure ─────────────────────────────────────────────────────

// Helper: sh factory that passes ensureRuntime checks (which/dpkg) but fails
// on actual build commands (cd <releasedir> && ...).
// WHY: ensureRuntime calls `sh -c "which <bin> && echo installed"` and
//      `sh -c "dpkg ..."`. Build steps call `sh -c "cd <path> && <cmd>"`.
//      We need to let ensureRuntime succeed so the test exercises build failure.
function shPassRuntimeFailBuild(errorMsg: string) {
  return (argv: string[]) => {
    const script = argv[2] ?? ""
    if (script.includes("which") || script.includes("dpkg")) return ok("installed")
    return fail(errorMsg)
  }
}

describe("deploy — build failure", () => {
  it("returns status=failure, current symlink is not changed", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
      sh: shPassRuntimeFailBuild("build exploded"),
    })

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)

    expect(result.status).toBe("failure")
    // No mv -Tf should have been called (swap never happened)
    const mvCalls = exec.callsFor("mv")
    expect(mvCalls.some((a) => a.includes("-Tf"))).toBe(false)
  })

  it("cleans up the release dir on build failure", async () => {
    const exec = new MockExecutor({
      readlink: ok(""),
      sh: shPassRuntimeFailBuild("install error"),
    })

    await deploy(makeConfig(), DEFAULT_OPTS, exec)

    const rmCalls = exec.callsFor("rm")
    expect(rmCalls.some((argv) => argv.some((p) => p.includes(DEFAULT_OPTS.sha)))).toBe(true)
  })

  it("logs build failure message", async () => {
    const exec = new MockExecutor({
      sh: shPassRuntimeFailBuild("tsc: error TS2345"),
    })

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)
    expect(result.log.some((l) => l.includes("FAILED"))).toBe(true)
  })
})

// ── Test 3: Health check failure → auto-rollback ──────────────────────────────

describe("deploy — health failure triggers auto-rollback", () => {
  it("returns status=rolled_back with rolledBackTo set", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
      curl: curlSequence(curlFail(), curlOk()),  // fail → rollback succeeds
    })

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("prevsha")
    expect(result.previousSha).toBe("prevsha")
  })

  it("restarts service twice: once for new deploy, once for rollback", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
      curl: curlSequence(curlFail(), curlOk()),
    })

    await deploy(makeConfig(), DEFAULT_OPTS, exec)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    expect(restartCalls.length).toBeGreaterThanOrEqual(2)
  })

  it("status=failure when both deploy AND rollback health fail", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
      curl: curlFail(),   // always fails
    })

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)
    expect(result.status).toBe("failure")
    expect(result.rolledBackTo).toBe("prevsha")
  })

  it("status=failure (no rollback) when no previous SHA exists", async () => {
    const exec = new MockExecutor({
      readlink: ok(""),
      curl: curlFail(),
    })

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec)
    expect(result.status).toBe("failure")
    expect(result.rolledBackTo).toBeNull()
    expect(result.log.some((l) => l.includes("no previous SHA"))).toBe(true)
  })
})

// ── Test 4: Static runtime (no systemd) ──────────────────────────────────────

describe("deploy — static runtime", () => {
  it("skips systemctl restart for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok(""), curl: curlOk() })

    await deploy(config, DEFAULT_OPTS, exec)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    expect(restartCalls.length).toBe(0)
  })

  it("skips writing systemd unit for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok(""), curl: curlOk() })

    await deploy(config, DEFAULT_OPTS, exec)

    const shCalls = exec.callsFor("sh").map((a) => a.join(" "))
    expect(shCalls.every((c) => !c.includes("/etc/systemd/system/"))).toBe(true)
  })

  it("still git-clones and builds for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok(""), curl: curlOk() })

    await deploy(config, DEFAULT_OPTS, exec)

    const gitCalls = exec.callsFor("git")
    expect(gitCalls.some((a) => a.includes("clone"))).toBe(true)
  })
})

// ── Test 5: GC keeps ≤ 3 releases ────────────────────────────────────────────

describe("deploy — GC keeps newest 3 releases", () => {
  it("calls rm -rf for releases beyond 3 (oldest first)", async () => {
    const findOutput = [
      "1000.0 sha001",
      "1001.0 sha002",
      "1002.0 sha003",
      "1003.0 sha004",
      "1004.0 sha005",
    ].join("\n")

    const exec = new MockExecutor({
      readlink: ok(""),
      find: ok(findOutput),
      curl: curlOk(),
    })

    await deploy(makeConfig(), DEFAULT_OPTS, exec)

    const rmCalls = exec.callsFor("rm").filter((a) => a.includes("-rf"))
    expect(rmCalls.some((a) => a.some((p) => p.includes("sha001")))).toBe(true)
    expect(rmCalls.some((a) => a.some((p) => p.includes("sha002")))).toBe(true)
    expect(rmCalls.every((a) => !a.some((p) => p.includes("sha003")))).toBe(true)
  })

  it("skips GC when ≤ 3 releases exist", async () => {
    const findOutput = ["1000.0 sha001", "1001.0 sha002"].join("\n")
    const exec = new MockExecutor({
      readlink: ok(""),
      find: ok(findOutput),
      curl: curlOk(),
    })

    await deploy(makeConfig(), DEFAULT_OPTS, exec)

    const rmCalls = exec.callsFor("rm").filter((a) => a.includes("-rf"))
    expect(rmCalls.every((a) => !a.some((p) => p.includes("sha001")))).toBe(true)
  })
})

// ── Test 6: rollback() manual ─────────────────────────────────────────────────

describe("rollback — manual rollback", () => {
  it("swaps to explicit toSha and restarts", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      test: ok(),
      curl: curlOk(),
    })

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc", toSha: "abc1234def0" },
      exec,
    )

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("abc1234def0")
  })

  it("reads previous SHA from state file when toSha not provided", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      cat: ok("abc1234def0"),   // valid hex SHA from state file
      test: ok(),
      curl: curlOk(),
    })

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc" },
      exec,
    )

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("abc1234def0")
  })

  it("returns failure when target release dir does not exist", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      test: fail(),
    })

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc", toSha: "abc1234def0" },
      exec,
    )

    expect(result.status).toBe("failure")
    expect(result.log.some((l) => l.includes("does not exist"))).toBe(true)
  })

  it("skips systemctl restart for static runtime in rollback", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({
      readlink: ok(""),
      test: ok(),
      curl: curlOk(),
    })

    await rollback(config, { lxc: "danmu-lxc", toSha: "abc1234def0" }, exec)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    expect(restartCalls.length).toBe(0)
  })
})

// ── Test 7: SHA validation ────────────────────────────────────────────────────

describe("deploy — SHA validation", () => {
  it("rejects non-hex sha", async () => {
    const exec = new MockExecutor({})
    const result = await deploy(makeConfig(), { ...DEFAULT_OPTS, sha: "not-a-sha!" }, exec)
    expect(result.status).toBe("failure")
    expect(result.log[0]).toMatch(/sha.*must match/)
  })

  it("rejects sha shorter than 7 chars", async () => {
    const exec = new MockExecutor({})
    const result = await deploy(makeConfig(), { ...DEFAULT_OPTS, sha: "abc12" }, exec)
    expect(result.status).toBe("failure")
  })

  it("accepts a valid 7-char short sha", async () => {
    const exec = new MockExecutor({ readlink: ok(""), curl: curlOk() })
    const result = await deploy(makeConfig(), { ...DEFAULT_OPTS, sha: "abc1234" }, exec)
    // Should not fail on SHA validation; may succeed or fail for other reasons
    expect(result.log[0]).not.toMatch(/sha.*must match/)
  })
})

describe("rollback — SHA validation", () => {
  it("rejects invalid toSha before any LXC command", async () => {
    const exec = new MockExecutor({})
    const result = await rollback(makeConfig(), { lxc: "danmu-lxc", toSha: "not-hex!" }, exec)
    expect(result.status).toBe("failure")
    expect(result.log[0]).toMatch(/sha.*must match/)
    // No LXC commands should have been issued
    expect(exec.calls.length).toBe(0)
  })
})

// ── Test 8: name validation in contract.ts ────────────────────────────────────

describe("parseKeelConfig — name validation", () => {
  it("accepts hostname-safe names", () => {
    expect(() => parseKeelConfig("name: danmu\nruntime: bun\nport: 3000\nexpose:\n  internal: x")).not.toThrow()
    expect(() => parseKeelConfig("name: my-app-1\nruntime: bun\nport: 3000\nexpose:\n  internal: x")).not.toThrow()
  })

  it("rejects name with shell metacharacters", () => {
    expect(() =>
      parseKeelConfig("name: \"x; rm -rf /\"\nruntime: bun\nport: 3000\nexpose:\n  internal: x"),
    ).toThrow("hostname-safe")
  })

  it("rejects name with uppercase letters", () => {
    expect(() =>
      parseKeelConfig("name: MyApp\nruntime: bun\nport: 3000\nexpose:\n  internal: x"),
    ).toThrow("hostname-safe")
  })

  it("rejects name with leading hyphen", () => {
    expect(() =>
      parseKeelConfig("name: -bad\nruntime: bun\nport: 3000\nexpose:\n  internal: x"),
    ).toThrow("hostname-safe")
  })

  it("rejects name longer than 63 chars", () => {
    const long = "a".repeat(64)
    expect(() =>
      parseKeelConfig(`name: ${long}\nruntime: bun\nport: 3000\nexpose:\n  internal: x`),
    ).toThrow("hostname-safe")
  })
})
