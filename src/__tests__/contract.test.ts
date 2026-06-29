import { describe, it, expect } from "bun:test"
import { parseKeelConfig } from "../contract.ts"

// ── Full valid config ─────────────────────────────────────────────────────────

const PAD_CORE_YAML = `
name: pad-core
runtime: bun
repo:
  build_path: apps/mcp
build:
  install: bun install --frozen-lockfile
  command: bun run build
run:
  command: bun run start
  working_dir: /opt/pad-core
port: 8080
health:
  url: http://localhost:8080/healthz
  timeout: 30
env_file: /etc/keel/pad-core.env
resources:
  cores: 2
  ram: 512
  disk: 16
  swap: 4096
expose:
  internal: pad-core.internal
  public: pad-core.app.zyx.tw
  public_path: /mcp
depends_on:
  - pad-db
`

describe("parseKeelConfig — full valid config", () => {
  it("parses all fields correctly", () => {
    const cfg = parseKeelConfig(PAD_CORE_YAML)
    expect(cfg.name).toBe("pad-core")
    expect(cfg.runtime).toBe("bun")
    expect(cfg.repo.build_path).toBe("apps/mcp")
    expect(cfg.build.install).toBe("bun install --frozen-lockfile")
    expect(cfg.build.command).toBe("bun run build")
    expect(cfg.run.command).toBe("bun run start")
    expect(cfg.run.working_dir).toBe("/opt/pad-core")
    expect(cfg.port).toBe(8080)
    expect(cfg.health.url).toBe("http://localhost:8080/healthz")
    expect(cfg.health.timeout).toBe(30)
    expect(cfg.env_file).toBe("/etc/keel/pad-core.env")
    expect(cfg.resources.cores).toBe(2)
    expect(cfg.resources.ram).toBe(512)
    expect(cfg.resources.disk).toBe(16)
    expect(cfg.resources.swap).toBe(4096)
    expect(cfg.expose.internal).toBe("pad-core.internal")
    expect(cfg.expose.public).toBe("pad-core.app.zyx.tw")
    expect(cfg.expose.public_path).toBe("/mcp")
    expect(cfg.depends_on).toEqual(["pad-db"])
  })
})

// ── Runtime defaults ──────────────────────────────────────────────────────────

describe("parseKeelConfig — runtime defaults", () => {
  it("bun: fills install/build/run defaults", () => {
    const cfg = parseKeelConfig(`
name: danmu
runtime: bun
port: 3000
expose:
  internal: danmu.internal
`)
    expect(cfg.build.install).toBe("bun install --frozen-lockfile")
    expect(cfg.build.command).toBe("bun run build")
    expect(cfg.run.command).toBe("bun run start")
    expect(cfg.run.working_dir).toBe("/opt/danmu")
  })

  it("node: fills install/build/run defaults", () => {
    const cfg = parseKeelConfig(`
name: my-app
runtime: node
port: 3000
expose:
  internal: my-app.internal
`)
    expect(cfg.build.install).toBe("npm ci")
    expect(cfg.build.command).toBe("npm run build")
    expect(cfg.run.command).toBe("node .")
  })

  it("python: no build default, run null from defaults is ok when overridden", () => {
    const cfg = parseKeelConfig(`
name: my-svc
runtime: python
port: 8000
run:
  command: uvicorn app:main --port 8000
expose:
  internal: my-svc.internal
`)
    expect(cfg.build.install).toBe("uv sync")
    expect(cfg.build.command).toBeNull()
    expect(cfg.run.command).toBe("uvicorn app:main --port 8000")
  })

  it("static: no run command required (Caddy file_server)", () => {
    const cfg = parseKeelConfig(`
name: my-site
runtime: static
port: 80
expose:
  internal: my-site.internal
`)
    expect(cfg.build.command).toBe("bun run build")
    expect(cfg.run.command).toBeNull()
  })

  it("defaults env_file to /etc/keel/<name>.env when omitted", () => {
    const cfg = parseKeelConfig(`
name: svc
runtime: bun
port: 8080
expose:
  internal: svc.internal
`)
    expect(cfg.env_file).toBe("/etc/keel/svc.env")
  })

  it("defaults health.url to http://localhost:<port>/healthz", () => {
    const cfg = parseKeelConfig(`
name: svc
runtime: bun
port: 9000
expose:
  internal: svc.internal
`)
    expect(cfg.health.url).toBe("http://localhost:9000/healthz")
    expect(cfg.health.timeout).toBe(30)
  })

  it("defaults resources to 1c/256MiB/8GiB/4096MiB-swap", () => {
    const cfg = parseKeelConfig(`
name: svc
runtime: bun
port: 8080
expose:
  internal: svc.internal
`)
    expect(cfg.resources).toEqual({ cores: 1, ram: 256, disk: 8, swap: 4096 })
  })

  it("explicit overrides win over defaults", () => {
    const cfg = parseKeelConfig(`
name: svc
runtime: bun
port: 8080
build:
  install: bun install
  command: null
expose:
  internal: svc.internal
`)
    expect(cfg.build.install).toBe("bun install")
    expect(cfg.build.command).toBeNull()
  })
})

// ── Validation: required fields ───────────────────────────────────────────────

describe("parseKeelConfig — validation errors", () => {
  it("throws on missing name", () => {
    expect(() =>
      parseKeelConfig(`runtime: bun\nport: 8080\nexpose:\n  internal: x.internal`),
    ).toThrow("name")
  })

  it("throws on missing port", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: bun\nexpose:\n  internal: x.internal`),
    ).toThrow("port")
  })

  it("throws on missing expose.internal", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: bun\nport: 8080`),
    ).toThrow("expose.internal")
  })

  it("throws on unknown runtime", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: ruby\nport: 3000\nexpose:\n  internal: x.internal`),
    ).toThrow("unknown runtime 'ruby'")
  })

  it("throws on invalid port (string)", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: bun\nport: notaport\nexpose:\n  internal: x.internal`),
    ).toThrow("port")
  })

  it("throws on invalid port (out of range)", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: bun\nport: 99999\nexpose:\n  internal: x.internal`),
    ).toThrow("port")
  })

  it("throws on bad YAML", () => {
    expect(() => parseKeelConfig("name: [unclosed")).toThrow("YAML parse error")
  })

  it("throws on non-object YAML", () => {
    expect(() => parseKeelConfig("- just a list")).toThrow("mapping")
  })

  it("throws when python runtime has no run command or systemd_unit", () => {
    expect(() =>
      parseKeelConfig(`name: svc\nruntime: python\nport: 8000\nexpose:\n  internal: x.internal`),
    ).toThrow("run.command or run.systemd_unit")
  })

  it("throws when depends_on is not a list", () => {
    expect(() =>
      parseKeelConfig(`
name: svc
runtime: bun
port: 8080
expose:
  internal: svc.internal
depends_on: pad-db
`),
    ).toThrow("depends_on")
  })
})

// ── Static runtime special case ───────────────────────────────────────────────

describe("parseKeelConfig — static runtime", () => {
  it("accepts static with no run.command (no systemd)", () => {
    const cfg = parseKeelConfig(`
name: docs
runtime: static
port: 80
expose:
  internal: docs.internal
  public: docs.app.zyx.tw
`)
    expect(cfg.runtime).toBe("static")
    expect(cfg.run.command).toBeNull()
    expect(cfg.run.systemd_unit).toBeUndefined()
  })

  it("static with explicit run.command is allowed (unusual but valid)", () => {
    const cfg = parseKeelConfig(`
name: docs
runtime: static
port: 80
run:
  command: npx serve dist
expose:
  internal: docs.internal
`)
    expect(cfg.run.command).toBe("npx serve dist")
  })
})

// ── Systemd unit override ─────────────────────────────────────────────────────

describe("parseKeelConfig — run.systemd_unit override", () => {
  it("accepts systemd_unit path instead of inline command", () => {
    const cfg = parseKeelConfig(`
name: svc
runtime: bun
port: 8080
run:
  systemd_unit: /etc/systemd/system/svc.service
expose:
  internal: svc.internal
`)
    expect(cfg.run.command).toBeNull()
    expect(cfg.run.systemd_unit).toBe("/etc/systemd/system/svc.service")
  })
})

// ── Sanity: example keel.yaml round-trip print ───────────────────────────────

describe("parseKeelConfig — example round-trip print", () => {
  it("prints merged config from minimal bun service", () => {
    const cfg = parseKeelConfig(`
name: minimal-svc
runtime: bun
port: 4000
expose:
  internal: minimal-svc.internal
`)
    // Just verify the shape is structurally complete and defaults are populated
    expect(cfg.name).toBe("minimal-svc")
    expect(cfg.runtime).toBe("bun")
    expect(cfg.port).toBe(4000)
    expect(cfg.build.install).not.toBeNull()
    expect(cfg.run.command).not.toBeNull()
    expect(cfg.health.url).toContain("4000")
    expect(cfg.depends_on).toEqual([])
    console.log("[keel.yaml example round-trip]", JSON.stringify(cfg, null, 2))
  })
})
