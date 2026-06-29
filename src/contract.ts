// keel.yaml contract parser — LXC-as-service deployment descriptor.
// WHY a separate file: the contract shape is used by deploy engine, MCP tools, and tests.
// Fail-closed: missing required fields or unknown enum values throw descriptive errors.

import { parse as parseYaml } from "yaml"

// ── Runtime defaults ──────────────────────────────────────────────────────────
// Each runtime ships sensible defaults so callers only override when they deviate.

export type Runtime = "bun" | "node" | "python" | "static"

const RUNTIME_DEFAULTS: Record<
  Runtime,
  { install: string | null; command: string | null; run: string | null }
> = {
  bun: {
    install: "bun install --frozen-lockfile",
    command: "bun run build",
    run: "bun run start",
  },
  node: {
    install: "npm ci",
    command: "npm run build",
    run: "node .",
  },
  python: {
    install: "uv sync",
    command: null,   // no build step for python
    run: null,       // caller must provide run.command or systemd_unit
  },
  static: {
    install: null,
    command: "bun run build",  // produces dist/; no systemd — Caddy file_server
    run: null,
  },
}

// ── Raw YAML shape (pre-merge) ────────────────────────────────────────────────

interface RawRepo {
  build_path?: string
}

interface RawBuild {
  install?: string | null
  command?: string | null
}

interface RawRun {
  command?: string | null
  working_dir?: string
  systemd_unit?: string
}

interface RawHealth {
  url?: string
  timeout?: number
}

interface RawResources {
  cores?: number
  ram?: number
  disk?: number
  swap?: number
}

interface RawExpose {
  internal?: string
  public?: string
  public_path?: string
}

interface RawKeelConfig {
  name?: unknown
  runtime?: unknown
  repo?: RawRepo
  build?: RawBuild
  run?: RawRun
  port?: unknown
  health?: RawHealth
  env_file?: unknown
  resources?: RawResources
  expose?: RawExpose
  depends_on?: unknown
}

// ── Fully-merged typed config ─────────────────────────────────────────────────

export interface KeelConfigBuild {
  install: string | null
  command: string | null
}

export interface KeelConfigRun {
  // null means static (Caddy file_server, no systemd)
  command: string | null
  working_dir: string
  // optional: override entire systemd unit path (advanced)
  systemd_unit?: string
}

export interface KeelConfigHealth {
  url: string
  timeout: number   // seconds
}

export interface KeelConfigResources {
  cores: number
  ram: number       // MiB
  disk: number      // GiB
  swap: number      // MiB
}

export interface KeelConfigExpose {
  internal: string
  public?: string
  public_path?: string
}

export interface KeelConfig {
  name: string
  runtime: Runtime
  repo: {
    build_path: string   // relative path within repo; "." means repo root
  }
  build: KeelConfigBuild
  run: KeelConfigRun
  port: number
  health: KeelConfigHealth
  env_file: string
  resources: KeelConfigResources
  expose: KeelConfigExpose
  depends_on: string[]
}

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_RUNTIMES = new Set<Runtime>(["bun", "node", "python", "static"])

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`keel.yaml: field '${field}' must be a non-empty string`)
  }
  return value
}

function assertRuntime(value: unknown): Runtime {
  const r = assertString(value, "runtime")
  if (!VALID_RUNTIMES.has(r as Runtime)) {
    throw new Error(
      `keel.yaml: unknown runtime '${r}' — expected one of: ${[...VALID_RUNTIMES].join(", ")}`,
    )
  }
  return r as Runtime
}

function assertPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`keel.yaml: field 'port' must be an integer between 1 and 65535`)
  }
  return value
}

// ── Parser (public surface) ───────────────────────────────────────────────────

/**
 * Parse and validate a keel.yaml string.
 *
 * Applies runtime-specific defaults so callers only override what they need.
 * Throws with a descriptive message on any validation failure (fail-closed).
 */
export function parseKeelConfig(raw: string): KeelConfig {
  let parsed: RawKeelConfig
  try {
    parsed = parseYaml(raw) as RawKeelConfig
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`keel.yaml: YAML parse error — ${msg}`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("keel.yaml: document must be a YAML mapping")
  }

  const name = assertString(parsed.name, "name")
  const runtime = assertRuntime(parsed.runtime)
  const port = assertPort(parsed.port)

  const defaults = RUNTIME_DEFAULTS[runtime]

  // repo
  const buildPath = parsed.repo?.build_path ?? "."

  // build — merge defaults then explicit overrides
  const buildInstall =
    parsed.build?.install !== undefined ? parsed.build.install : defaults.install
  const buildCommand =
    parsed.build?.command !== undefined ? parsed.build.command : defaults.command

  // run — static runtime has no systemd by design; others must resolve a command
  const rawRun = parsed.run
  const runCommand =
    rawRun?.command !== undefined
      ? rawRun.command
      : rawRun?.systemd_unit !== undefined
        ? null   // explicit systemd_unit means no inline command needed
        : defaults.run

  const runWorkingDir = rawRun?.working_dir ?? `/opt/${name}`
  const runSystemdUnit = rawRun?.systemd_unit

  // validate: non-static runtime must have either run.command or run.systemd_unit
  if (runtime !== "static" && runCommand === null && !runSystemdUnit) {
    throw new Error(
      `keel.yaml: runtime '${runtime}' requires run.command or run.systemd_unit`,
    )
  }

  // health
  const healthUrl =
    parsed.health?.url ?? `http://localhost:${port}/healthz`
  const healthTimeout = parsed.health?.timeout ?? 30

  // env_file
  const envFile =
    typeof parsed.env_file === "string" && parsed.env_file.trim() !== ""
      ? parsed.env_file
      : `/etc/keel/${name}.env`

  // resources — sane defaults for a small service
  const resources: KeelConfigResources = {
    cores: parsed.resources?.cores ?? 1,
    ram: parsed.resources?.ram ?? 256,
    disk: parsed.resources?.disk ?? 8,
    swap: parsed.resources?.swap ?? 4096,
  }

  // expose
  if (!parsed.expose?.internal) {
    throw new Error(`keel.yaml: field 'expose.internal' is required`)
  }
  const expose: KeelConfigExpose = {
    internal: assertString(parsed.expose.internal, "expose.internal"),
    public: parsed.expose.public,
    public_path: parsed.expose.public_path,
  }

  // depends_on — must be string array if present
  let dependsOn: string[] = []
  if (parsed.depends_on !== undefined) {
    if (!Array.isArray(parsed.depends_on)) {
      throw new Error("keel.yaml: 'depends_on' must be a list of service names")
    }
    dependsOn = (parsed.depends_on as unknown[]).map((d, i) => {
      if (typeof d !== "string" || d.trim() === "") {
        throw new Error(`keel.yaml: depends_on[${i}] must be a non-empty string`)
      }
      return d
    })
  }

  const result: KeelConfig = {
    name,
    runtime,
    repo: { build_path: buildPath },
    build: { install: buildInstall, command: buildCommand },
    run: {
      command: runCommand,
      working_dir: runWorkingDir,
      ...(runSystemdUnit !== undefined ? { systemd_unit: runSystemdUnit } : {}),
    },
    port,
    health: { url: healthUrl, timeout: healthTimeout },
    env_file: envFile,
    resources,
    expose,
    depends_on: dependsOn,
  }

  return result
}
