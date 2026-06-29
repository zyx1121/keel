// deploy-engine.test.ts — unit tests using mock executor + health checker.
// No real LXC, no SSH, no HTTP.

import { describe, it, expect, beforeEach } from "bun:test"
import {
  deploy,
  rollback,
  type LxcExecutor,
  type ExecResult,
  type HealthChecker,
} from "../deploy-engine.ts"
import type { KeelConfig } from "../contract.ts"

// ── Test helpers ──────────────────────────────────────────────────────────────

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" }
}

function fail(stderr = "mock error"): ExecResult {
  return { code: 1, stdout: "", stderr }
}

/**
 * Programmable mock executor.
 * - `responses` maps argv[0] (the command verb) to a result.
 * - Anything not in the map returns ok().
 * - Use `calls` to inspect what was executed.
 */
class MockExecutor implements LxcExecutor {
  calls: Array<{ lxc: string; argv: string[] }> = []
  private responses: Map<string, ExecResult | (() => ExecResult)>

  constructor(responses: Record<string, ExecResult | (() => ExecResult)> = {}) {
    this.responses = new Map(Object.entries(responses))
  }

  async run(lxc: string, argv: string[]): Promise<ExecResult> {
    this.calls.push({ lxc, argv })
    const verb = argv[0] ?? ""
    const entry = this.responses.get(verb)
    if (entry === undefined) return ok()
    return typeof entry === "function" ? entry() : entry
  }

  /** Return all argv arrays where argv[0] === verb. */
  callsFor(verb: string): string[][] {
    return this.calls.filter((c) => c.argv[0] === verb).map((c) => c.argv)
  }

  /** Return all full argv arrays that include a given substring anywhere. */
  callsContaining(substr: string): string[][] {
    return this.calls
      .filter((c) => c.argv.some((a) => a.includes(substr)))
      .map((c) => c.argv)
  }
}

/** Programmable health checker.
 *
 * Each element of `sequence` is returned in order; after the sequence is
 * exhausted the last value repeats (so [false] means "always unhealthy").
 */
class MockHealthChecker implements HealthChecker {
  private sequence: boolean[]
  private idx = 0

  constructor(sequence: boolean[]) {
    this.sequence = sequence.length > 0 ? sequence : [false]
  }

  async check(_url: string): Promise<{ ok: boolean; status: number }> {
    const result = this.sequence[Math.min(this.idx, this.sequence.length - 1)] ?? false
    this.idx++
    return { ok: result, status: result ? 200 : 503 }
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

// ── Test 1: Happy path ────────────────────────────────────────────────────────

describe("deploy — happy path", () => {
  let exec: MockExecutor
  let health: MockHealthChecker

  beforeEach(() => {
    exec = new MockExecutor({
      // readlink for currentSha returns empty (first deploy)
      readlink: ok(""),
    })
    // Health succeeds immediately
    health = new MockHealthChecker([true])
  })

  it("returns status=success", async () => {
    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    expect(result.status).toBe("success")
    expect(result.sha).toBe(DEFAULT_OPTS.sha)
  })

  it("calls git clone with correct sha and repoUrl", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    const cloneCalls = exec.callsFor("git")
    expect(cloneCalls.length).toBeGreaterThanOrEqual(1)
    const cloneCall = cloneCalls[0]!
    expect(cloneCall).toContain("clone")
    expect(cloneCall).toContain(DEFAULT_OPTS.repoUrl)
    expect(cloneCall.some((a) => a.includes(DEFAULT_OPTS.sha))).toBe(true)
  })

  it("runs build install and command", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    const shCalls = exec.callsFor("sh")
    const buildCmds = shCalls.map((a) => a.join(" "))
    expect(buildCmds.some((c) => c.includes("bun install"))).toBe(true)
    expect(buildCmds.some((c) => c.includes("bun run build"))).toBe(true)
  })

  it("calls systemctl restart after swap", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    const restartCalls = exec.callsFor("systemctl")
    expect(restartCalls.some((a) => a.includes("restart"))).toBe(true)
  })

  it("performs atomic symlink swap (mv -Tf)", async () => {
    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    const mvCalls = exec.callsFor("mv")
    expect(mvCalls.some((a) => a.includes("-Tf"))).toBe(true)
  })

  it("embeds clone token in URL but not in result.log", async () => {
    const tokenExec = new MockExecutor({ readlink: ok("") })
    const tokenHealth = new MockHealthChecker([true])
    const opts = { ...DEFAULT_OPTS, cloneToken: "ghs_test_token" }

    const result = await deploy(makeConfig(), opts, tokenExec, tokenHealth)

    const cloneCalls = tokenExec.callsFor("git")
    const cloneCall = cloneCalls[0]!.join(" ")
    // Token must be present in the argv sent to executor (clone URL)
    expect(cloneCall).toContain("x-access-token:ghs_test_token")
    // Token must NOT leak into the human-readable log
    expect(result.log.join("\n")).not.toContain("ghs_test_token")
  })
})

// ── Test 2: Build failure ─────────────────────────────────────────────────────

describe("deploy — build failure", () => {
  it("returns status=failure, current symlink is not changed", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
      sh: fail("build exploded"),
    })
    const health = new MockHealthChecker([])  // should never be called

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    expect(result.status).toBe("failure")
    // No mv -Tf should have been called (swap never happened)
    const mvCalls = exec.callsFor("mv")
    expect(mvCalls.some((a) => a.includes("-Tf"))).toBe(false)
  })

  it("cleans up the release dir on build failure", async () => {
    const exec = new MockExecutor({
      readlink: ok(""),
      sh: fail("install error"),
    })
    const health = new MockHealthChecker([])

    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    const rmCalls = exec.callsFor("rm")
    // argv element contains the sha as part of the path
    expect(rmCalls.some((argv) => argv.some((p) => p.includes(DEFAULT_OPTS.sha)))).toBe(true)
  })

  it("logs build failure message", async () => {
    const exec = new MockExecutor({
      sh: fail("tsc: error TS2345"),
    })
    const health = new MockHealthChecker([])

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    expect(result.log.some((l) => l.includes("FAILED"))).toBe(true)
  })
})

// ── Test 3: Health check failure → auto-rollback ──────────────────────────────

describe("deploy — health failure triggers auto-rollback", () => {
  it("returns status=rolled_back with rolledBackTo set", async () => {
    // readlink: returns previous release path so previousSha is "prevsha"
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
    })
    // Health fails for new deploy, succeeds for rollback
    const health = new MockHealthChecker([false, true])

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("prevsha")
    expect(result.previousSha).toBe("prevsha")
  })

  it("restarts service twice: once for new deploy, once for rollback", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
    })
    const health = new MockHealthChecker([false, true])

    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    // First restart (new deploy) + second restart (rollback)
    expect(restartCalls.length).toBeGreaterThanOrEqual(2)
  })

  it("status=failure when both deploy AND rollback health fail", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/prevsha"),
    })
    // Both polls fail
    const health = new MockHealthChecker([false, false])

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    expect(result.status).toBe("failure")
    expect(result.rolledBackTo).toBe("prevsha")  // did attempt rollback
  })

  it("status=failure (no rollback) when no previous SHA exists", async () => {
    const exec = new MockExecutor({
      readlink: ok(""),  // no current link — first deploy, health fails
    })
    const health = new MockHealthChecker([false])

    const result = await deploy(makeConfig(), DEFAULT_OPTS, exec, health)
    expect(result.status).toBe("failure")
    expect(result.rolledBackTo).toBeNull()
    expect(result.log.some((l) => l.includes("no previous SHA"))).toBe(true)
  })
})

// ── Test 4: Static runtime (no systemd) ──────────────────────────────────────

describe("deploy — static runtime", () => {
  it("skips systemctl restart for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok("") })
    const health = new MockHealthChecker([true])

    await deploy(config, DEFAULT_OPTS, exec, health)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    expect(restartCalls.length).toBe(0)
  })

  it("skips writing systemd unit for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok("") })
    const health = new MockHealthChecker([true])

    await deploy(config, DEFAULT_OPTS, exec, health)

    // No sh call should write /etc/systemd/system/
    const shCalls = exec.callsFor("sh").map((a) => a.join(" "))
    expect(shCalls.every((c) => !c.includes("/etc/systemd/system/"))).toBe(true)
  })

  it("still git-clones and builds for static", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({ readlink: ok("") })
    const health = new MockHealthChecker([true])

    await deploy(config, DEFAULT_OPTS, exec, health)

    const gitCalls = exec.callsFor("git")
    expect(gitCalls.some((a) => a.includes("clone"))).toBe(true)
  })
})

// ── Test 5: GC keeps ≤ 3 releases ────────────────────────────────────────────

describe("deploy — GC keeps newest 3 releases", () => {
  it("calls rm -rf for releases beyond 3 (oldest first)", async () => {
    // Simulate find returning 5 releases; mtime ascending (oldest first)
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
    })
    const health = new MockHealthChecker([true])

    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    // Expect rm calls for sha001 and sha002 (oldest 2)
    const rmCalls = exec.callsFor("rm").filter((a) => a.includes("-rf"))
    expect(rmCalls.some((a) => a.some((p) => p.includes("sha001")))).toBe(true)
    expect(rmCalls.some((a) => a.some((p) => p.includes("sha002")))).toBe(true)
    // sha003/004/005 should NOT be removed
    expect(rmCalls.every((a) => !a.some((p) => p.includes("sha003")))).toBe(true)
  })

  it("skips GC when ≤ 3 releases exist", async () => {
    const findOutput = ["1000.0 sha001", "1001.0 sha002"].join("\n")
    const exec = new MockExecutor({
      readlink: ok(""),
      find: ok(findOutput),
    })
    const health = new MockHealthChecker([true])

    await deploy(makeConfig(), DEFAULT_OPTS, exec, health)

    // rm -rf should not include sha001 or sha002
    const rmCalls = exec.callsFor("rm").filter((a) => a.includes("-rf"))
    expect(rmCalls.every((a) => !a.some((p) => p.includes("sha001")))).toBe(true)
  })
})

// ── Test 6: rollback() manual ─────────────────────────────────────────────────

describe("rollback — manual rollback", () => {
  it("swaps to explicit toSha and restarts", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      test: ok(),   // release dir exists
    })
    const health = new MockHealthChecker([true])

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc", toSha: "oldsha" },
      exec,
      health,
    )

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("oldsha")
  })

  it("reads previous SHA from state file when toSha not provided", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      cat: ok("storedprevsha"),
      test: ok(),
    })
    const health = new MockHealthChecker([true])

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc" },
      exec,
      health,
    )

    expect(result.status).toBe("rolled_back")
    expect(result.rolledBackTo).toBe("storedprevsha")
  })

  it("returns failure when target release dir does not exist", async () => {
    const exec = new MockExecutor({
      readlink: ok("/srv/danmu/releases/currentsha"),
      test: fail(),   // release dir missing
    })
    const health = new MockHealthChecker([])

    const result = await rollback(
      makeConfig(),
      { lxc: "danmu-lxc", toSha: "ghostsha" },
      exec,
      health,
    )

    expect(result.status).toBe("failure")
    expect(result.log.some((l) => l.includes("does not exist"))).toBe(true)
  })

  it("skips systemctl restart for static runtime in rollback", async () => {
    const config = makeConfig({ runtime: "static", run: { command: null, working_dir: "/opt/danmu" } })
    const exec = new MockExecutor({
      readlink: ok(""),
      test: ok(),
    })
    const health = new MockHealthChecker([true])

    await rollback(config, { lxc: "danmu-lxc", toSha: "oldsha" }, exec, health)

    const restartCalls = exec.callsFor("systemctl").filter((a) => a.includes("restart"))
    expect(restartCalls.length).toBe(0)
  })
})
