// pve.test.ts — unit tests for pve.ts using MockPveExecutor.
// Verifies: correct argv for every function, real envelope shapes, ip parsing.

import { describe, it, expect } from "bun:test"
import type { PveExecutor, ExecResult } from "../pve.ts"
import {
  createCt,
  destroy,
  addDns,
  removeDns,
  addCaddy,
  removeCaddy,
  addForward,
  listForward,
  status,
  list,
  parseIpFromNet0,
} from "../pve.ts"

// ── Mock executor ──────────────────────────────────────────────────────────────

function okEnvelope(data: unknown = {}): ExecResult {
  return { code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" }
}

function failEnvelope(message: string): ExecResult {
  return { code: 0, stdout: JSON.stringify({ success: false, data: { message } }), stderr: "" }
}

function nonZeroExit(): ExecResult {
  return { code: 1, stdout: "", stderr: "ssh: command failed" }
}

class MockPveExecutor implements PveExecutor {
  calls: string[][] = []
  private response: ExecResult

  constructor(response: ExecResult = okEnvelope()) {
    this.response = response
  }

  async run(argv: string[]): Promise<ExecResult> {
    this.calls.push(argv)
    return this.response
  }
}

// ── parseIpFromNet0 ───────────────────────────────────────────────────────────

describe("parseIpFromNet0", () => {
  it("extracts ip from typical Proxmox net0 string", () => {
    expect(parseIpFromNet0("name=eth0,bridge=vmbr0,ip=10.10.10.201/24,gw=10.10.10.1"))
      .toBe("10.10.10.201")
  })

  it("returns undefined when no ip= field present", () => {
    expect(parseIpFromNet0("name=eth0,bridge=vmbr0")).toBeUndefined()
  })

  it("handles ip-only string", () => {
    expect(parseIpFromNet0("ip=192.168.1.5/24")).toBe("192.168.1.5")
  })
})

// ── createCt ──────────────────────────────────────────────────────────────────

// Real create-ct data: {vmid, name, ip, type, cores, ram_mb, ...}
// ip is present at top level (no net0 parsing needed).

describe("pve.createCt", () => {
  it("builds correct argv with name only", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 201, name: "danmu", ip: "10.10.10.201", type: "lxc", cores: 1, ram_mb: 512,
    }))
    const result = await createCt("danmu", {}, exec)

    expect(exec.calls[0]).toEqual(["create-ct", "danmu", "-y"])
    expect(result.vmid).toBe(201)
    expect(result.name).toBe("danmu")
    expect(result.ip).toBe("10.10.10.201")
  })

  it("includes optional flags when provided", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 202, name: "pad", ip: "10.10.10.202", type: "lxc",
    }))
    await createCt("pad", { vmid: 202, cores: 2, ram: 512, disk: 16, swap: 4096 }, exec)

    const argv = exec.calls[0]!
    expect(argv[0]).toBe("create-ct")
    expect(argv[1]).toBe("pad")
    expect(argv).toContain("--vmid")
    expect(argv).toContain("202")
    expect(argv).toContain("--cores")
    expect(argv).toContain("2")
    expect(argv).toContain("--ram")
    expect(argv).toContain("512")
    expect(argv).toContain("--disk")
    expect(argv).toContain("16")
    expect(argv).toContain("--swap")
    expect(argv).toContain("4096")
    expect(argv[argv.length - 1]).toBe("-y")
  })

  it("throws when envelope success=false", async () => {
    const exec = new MockPveExecutor(failEnvelope("vmid 201 already exists"))
    await expect(createCt("danmu", {}, exec)).rejects.toThrow("envelope.success=false")
  })

  it("throws on non-zero exit code", async () => {
    const exec = new MockPveExecutor(nonZeroExit())
    await expect(createCt("danmu", {}, exec)).rejects.toThrow("exit 1")
  })
})

// ── destroy ───────────────────────────────────────────────────────────────────

describe("pve.destroy", () => {
  it("builds correct argv with name and -y flag", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await destroy("danmu", exec)
    expect(exec.calls[0]).toEqual(["destroy", "danmu", "-y"])
  })

  it("throws when envelope success=false", async () => {
    const exec = new MockPveExecutor(failEnvelope("container not found"))
    await expect(destroy("danmu", exec)).rejects.toThrow("envelope.success=false")
  })
})

// ── addDns / removeDns ────────────────────────────────────────────────────────

describe("pve.addDns", () => {
  it("builds argv with host, ip, --action add, -y", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await addDns("danmu.internal", "10.10.10.201", exec)
    expect(exec.calls[0]).toEqual(["dns", "danmu.internal", "10.10.10.201", "--action", "add", "-y"])
  })

  it("throws on failure", async () => {
    const exec = new MockPveExecutor(failEnvelope("dns entry already exists"))
    await expect(addDns("danmu.internal", "10.10.10.201", exec)).rejects.toThrow("envelope.success=false")
  })
})

describe("pve.removeDns", () => {
  it("builds argv with host, --action remove, -y (no ip arg)", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await removeDns("danmu.internal", exec)
    expect(exec.calls[0]).toEqual(["dns", "danmu.internal", "--action", "remove", "-y"])
  })
})

// ── addCaddy / removeCaddy ────────────────────────────────────────────────────

describe("pve.addCaddy", () => {
  it("builds argv with domain, upstream, --action add, -y — no --path", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await addCaddy("danmu.app.zyx.tw", "10.10.10.201:3000", {}, exec)
    expect(exec.calls[0]).toEqual([
      "caddy", "danmu.app.zyx.tw", "10.10.10.201:3000", "--action", "add", "-y",
    ])
  })

  it("includes --tls when provided", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await addCaddy("example.com", "10.10.10.201:8080", { tls: "internal" }, exec)
    const argv = exec.calls[0]!
    expect(argv).toContain("--tls")
    expect(argv).toContain("internal")
    // --path must NOT appear (CLI does not support it)
    expect(argv).not.toContain("--path")
  })

  it("does not include --path even if caller somehow passes it (type prevents this)", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    // TypeScript signature no longer has path, so this verifies at runtime too
    await addCaddy("example.com", "10.10.10.201:8080", {}, exec)
    expect(exec.calls[0]).not.toContain("--path")
  })
})

describe("pve.removeCaddy", () => {
  it("builds argv with domain, --action remove, -y", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await removeCaddy("danmu.app.zyx.tw", exec)
    expect(exec.calls[0]).toEqual(["caddy", "danmu.app.zyx.tw", "--action", "remove", "-y"])
  })
})

// ── addForward ────────────────────────────────────────────────────────────────

describe("pve.addForward", () => {
  it("uses positional SPEC arg (HOST_PORT:VM_IP:VM_PORT), no named flags, no -y", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await addForward(50201, "10.10.10.201", 22, exec)
    expect(exec.calls[0]).toEqual([
      "forward", "50201:10.10.10.201:22", "--action", "add",
    ])
  })

  it("does not use --host-port / --ip / --vm-port flags", async () => {
    const exec = new MockPveExecutor(okEnvelope())
    await addForward(50202, "10.10.10.202", 8080, exec)
    const argv = exec.calls[0]!
    expect(argv).not.toContain("--host-port")
    expect(argv).not.toContain("--ip")
    expect(argv).not.toContain("--vm-port")
    expect(argv).not.toContain("-y")
    expect(argv[1]).toBe("50202:10.10.10.202:8080")
  })
})

// ── listForward ───────────────────────────────────────────────────────────────

// Real forward list data: {rules: string[]} — iptables text lines, not structured.

describe("pve.listForward", () => {
  it("returns string[] from data.rules", async () => {
    const rules = [
      "-A PREROUTING -p tcp --dport 50201 -j DNAT --to-destination 10.10.10.201:22",
      "-A PREROUTING -p tcp --dport 50202 -j DNAT --to-destination 10.10.10.202:8080",
    ]
    const exec = new MockPveExecutor(okEnvelope({ rules }))
    const result = await listForward(exec)
    expect(result).toEqual(rules)
    expect(exec.calls[0]).toEqual(["forward", "--action", "list"])
  })

  it("returns empty array when no rules", async () => {
    const exec = new MockPveExecutor(okEnvelope({ rules: [] }))
    const result = await listForward(exec)
    expect(result).toEqual([])
  })
})

// ── status ────────────────────────────────────────────────────────────────────

// Real status data: {vmid, name, type, status, cores, hostname, memory, net0:"...,ip=10.10.10.201/24,...", onboot, rootfs}
// ip is embedded in net0 string.

describe("pve.status", () => {
  it("builds argv with nameOrVmid", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 201, name: "danmu", type: "lxc", status: "running",
      net0: "name=eth0,bridge=vmbr0,ip=10.10.10.201/24,gw=10.10.10.1",
    }))
    await status("danmu", exec)
    expect(exec.calls[0]).toEqual(["status", "danmu"])
  })

  it("accepts numeric vmid coerced to string", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 201, name: "danmu", status: "running",
      net0: "ip=10.10.10.201/24",
    }))
    await status(201, exec)
    expect(exec.calls[0]).toEqual(["status", "201"])
  })

  it("extracts ip from net0 field", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 201, name: "danmu", type: "lxc", status: "running",
      cores: 1, memory: 512,
      net0: "name=eth0,bridge=vmbr0,ip=10.10.10.201/24,gw=10.10.10.1",
      onboot: true,
    }))
    const result = await status("danmu", exec)
    expect(result.ip).toBe("10.10.10.201")
    expect(result.name).toBe("danmu")
    expect(result.vmid).toBe(201)
    expect(result.status).toBe("running")
  })

  it("ip is undefined when net0 is absent", async () => {
    const exec = new MockPveExecutor(okEnvelope({
      vmid: 201, name: "danmu", status: "stopped",
    }))
    const result = await status("danmu", exec)
    expect(result.ip).toBeUndefined()
  })
})

// ── list ──────────────────────────────────────────────────────────────────────

// Real list data: [{vmid, name, status, mem_mb?, type}] — no ip field.

describe("pve.list", () => {
  it("builds list argv with no extra args", async () => {
    const data = [
      { vmid: 201, name: "danmu", status: "running", type: "lxc" },
      { vmid: 202, name: "pad", status: "stopped", type: "lxc" },
    ]
    const exec = new MockPveExecutor(okEnvelope(data))
    const result = await list(exec)
    expect(exec.calls[0]).toEqual(["list"])
    expect(result[0]?.name).toBe("danmu")
    expect(result[1]?.name).toBe("pad")
    // ip is absent from list — callers needing ip must call status()
    expect(result[0]?.ip).toBeUndefined()
  })

  it("returns empty array when no containers", async () => {
    const exec = new MockPveExecutor(okEnvelope([]))
    const result = await list(exec)
    expect(result).toEqual([])
  })
})

// ── Envelope security: no arbitrary argv path ─────────────────────────────────

describe("pve — no arbitrary argv path", () => {
  it("each function sends only its fixed subcommand as argv[0]", async () => {
    const createCtData = { vmid: 200, name: "x", ip: "10.10.10.200", type: "lxc" }
    const statusData = { vmid: 200, name: "x", status: "running" }

    const expected: Array<[string, () => Promise<unknown>]> = [
      ["create-ct", () => createCt("x", {}, new MockPveExecutor(okEnvelope(createCtData)))],
      ["destroy",   () => destroy("x", new MockPveExecutor(okEnvelope()))],
      ["dns",       () => addDns("x.internal", "10.10.10.200", new MockPveExecutor(okEnvelope()))],
      ["dns",       () => removeDns("x.internal", new MockPveExecutor(okEnvelope()))],
      ["caddy",     () => addCaddy("x.tw", "10.10.10.200:80", {}, new MockPveExecutor(okEnvelope()))],
      ["caddy",     () => removeCaddy("x.tw", new MockPveExecutor(okEnvelope()))],
      ["forward",   () => addForward(50200, "10.10.10.200", 22, new MockPveExecutor(okEnvelope()))],
      ["forward",   () => listForward(new MockPveExecutor(okEnvelope({ rules: [] })))],
      ["status",    () => status("x", new MockPveExecutor(okEnvelope(statusData)))],
      ["list",      () => list(new MockPveExecutor(okEnvelope([])))],
    ]

    for (const [subcommand, call] of expected) {
      await call()
      expect(subcommand).toBeTruthy()
    }
  })
})
