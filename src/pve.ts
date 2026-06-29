// pve.ts — keel's ONLY infra exit point.
//
// Security model:
//   - Every function maps 1:1 to a fixed `utils pve` subcommand.
//   - Parameters are structured (typed). Argv is assembled inside each function.
//   - There is NO path to run an arbitrary command string. New capability =
//     new typed function (= code review gate for allowlist expansion).
//   - PveExecutor is injectable so tests can mock without real SSH.
//   - Production executor: `ssh <pve-keel-alias> utils pve <argv...>` via
//     buildRemoteCommand() quoting (same as deploy-engine.ts).
//     TODO(bootstrap): V1.6 sets up the forced-command authorized_keys entry on
//     PVE so this key can only run `utils pve` — not a root shell.

import { buildRemoteCommand } from "./deploy-engine.ts"

// ── Executor interface ─────────────────────────────────────────────────────────

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Abstraction over "run a utils pve argv on PVE host".
 *
 * Production impl: SshPveExecutor (see below).
 * Test impl: MockPveExecutor.
 *
 * Note: argv here is the arguments AFTER `utils pve` — the executor
 * prepends `utils pve` before running. This lets tests inspect argv
 * without caring about the SSH transport.
 */
export interface PveExecutor {
  run(argv: string[]): Promise<ExecResult>
}

// ── Envelope type ──────────────────────────────────────────────────────────────

interface UtilsEnvelope<T = unknown> {
  success: boolean
  data: T
  metadata?: Record<string, unknown>
}

// ── Envelope parse + throw-on-failure ─────────────────────────────────────────

function parseEnvelope<T>(result: ExecResult, context: string): T {
  if (result.code !== 0) {
    // Non-zero exit before JSON: use stderr as message
    throw new Error(`pve: ${context} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  }

  let envelope: UtilsEnvelope<T>
  try {
    envelope = JSON.parse(result.stdout) as UtilsEnvelope<T>
  } catch {
    throw new Error(`pve: ${context} returned non-JSON stdout: ${result.stdout.slice(0, 200)}`)
  }

  if (!envelope.success) {
    const msg = (envelope.data as { message?: string })?.message
      ?? JSON.stringify(envelope.data)
    throw new Error(`pve: ${context} envelope.success=false: ${msg}`)
  }

  return envelope.data
}

// ── Production executor ────────────────────────────────────────────────────────

/**
 * Runs `utils pve <argv...>` over SSH to the PVE host.
 *
 * The ssh alias "pve-keel" must be configured in ~/.ssh/config in the keel LXC
 * and its authorized_keys on PVE must use a forced-command that allows only
 * `utils pve` (V1.6 bootstrap task).
 *
 * Each run() passes the remote command as a single quoted string so argument
 * boundaries survive OpenSSH's argument-joining behaviour (same fix as
 * SshLxcExecutor in deploy-engine.ts).
 */
export class SshPveExecutor implements PveExecutor {
  constructor(private readonly alias: string = "pve-keel") {}

  async run(argv: string[]): Promise<ExecResult> {
    const fullArgv = ["utils", "pve", ...argv]
    const remoteCmd = buildRemoteCommand(fullArgv)
    const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", this.alias, remoteCmd], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code: exitCode, stdout, stderr }
  }
}

// ── Singleton (lazy) ───────────────────────────────────────────────────────────

let _pve: PveExecutor | null = null

export function getPveExecutor(): PveExecutor {
  if (!_pve) _pve = new SshPveExecutor()
  return _pve
}

/** Override executor for testing. */
export function setPveExecutor(exec: PveExecutor): void {
  _pve = exec
}

// ── Result types ───────────────────────────────────────────────────────────────

export interface CtInfo {
  vmid: number
  name: string       // container hostname / name field
  status?: string
  ip?: string        // absent in list output; parsed from net0 in status output
}

/**
 * Parse the ip= field out of a Proxmox net0 string.
 *
 * Real status data shape: net0 = "name=eth0,bridge=vmbr0,ip=10.10.10.201/24,..."
 * Returns the bare IP without the prefix length, or undefined if not found.
 */
export function parseIpFromNet0(net0: string): string | undefined {
  const m = net0.match(/ip=([\d.]+)\//)
  return m?.[1]
}

// ── Fixed function set (allowlist) ─────────────────────────────────────────────
//
// Each function = exactly one `utils pve` subcommand.
// Callers pass structured arguments; argv is built inside.
// No caller can inject arbitrary subcommand fragments.

/**
 * Provision a new LXC container.
 *
 * Maps to: utils pve create-ct <name> [--vmid ..] [--cores ..] [--ram ..] [--disk ..] [--swap ..] -y
 *
 * VMID defaults to next free ≥200 (2xx range) — handled by utils pve itself.
 */
export async function createCt(
  name: string,
  opts: {
    vmid?: number
    ip?: string
    cores?: number
    ram?: number
    disk?: number
    swap?: number
  } = {},
  exec: PveExecutor = getPveExecutor(),
): Promise<CtInfo> {
  const argv: string[] = ["create-ct", name]
  if (opts.vmid !== undefined) argv.push("--vmid", String(opts.vmid))
  if (opts.ip !== undefined) argv.push("--ip", opts.ip)
  if (opts.cores !== undefined) argv.push("--cores", String(opts.cores))
  if (opts.ram !== undefined) argv.push("--ram", String(opts.ram))
  if (opts.disk !== undefined) argv.push("--disk", String(opts.disk))
  if (opts.swap !== undefined) argv.push("--swap", String(opts.swap))
  argv.push("-y")
  const result = await exec.run(argv)
  // create-ct data: {vmid, name, ip, type, cores, ram_mb, ...}
  // ip is present at top level — no net0 parsing needed here.
  return parseEnvelope<CtInfo>(result, "create-ct")
}

/**
 * Destroy a container (cascade: stops, removes iptables, cleans up).
 *
 * Maps to: utils pve destroy <name> -y
 */
export async function destroy(
  name: string,
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const argv = ["destroy", name, "-y"]
  const result = await exec.run(argv)
  parseEnvelope(result, "destroy")
}

/**
 * Add a dnsmasq entry: <host> → <ip>.
 *
 * Maps to: utils pve dns <host> <ip> --action add -y
 */
export async function addDns(
  host: string,
  ip: string,
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const argv = ["dns", host, ip, "--action", "add", "-y"]
  const result = await exec.run(argv)
  parseEnvelope(result, "dns add")
}

/**
 * Remove a dnsmasq entry.
 *
 * Maps to: utils pve dns <host> --action remove -y
 */
export async function removeDns(
  host: string,
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const argv = ["dns", host, "--action", "remove", "-y"]
  const result = await exec.run(argv)
  parseEnvelope(result, "dns remove")
}

/**
 * Add a Caddy reverse-proxy route.
 *
 * Maps to: utils pve caddy <domain> <upstream> [--tls TEXT] --action add -y
 *
 * NOTE: --path is NOT supported by the CLI.
 * TODO(V3): implement path routing via --body when migrating mcp/pad.
 */
export async function addCaddy(
  domain: string,
  upstream: string,
  opts: { tls?: string } = {},
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const argv: string[] = ["caddy", domain, upstream]
  if (opts.tls) argv.push("--tls", opts.tls)
  argv.push("--action", "add", "-y")
  const result = await exec.run(argv)
  parseEnvelope(result, "caddy add")
}

/**
 * Remove a Caddy route.
 *
 * Maps to: utils pve caddy <domain> --action remove -y
 */
export async function removeCaddy(
  domain: string,
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const argv = ["caddy", domain, "--action", "remove", "-y"]
  const result = await exec.run(argv)
  parseEnvelope(result, "caddy remove")
}

/**
 * Add a port-forward DNAT rule: <hostPort> → <ip>:<vmPort>.
 *
 * Maps to: utils pve forward <HOST_PORT:VM_IP:VM_PORT> --action add
 * SPEC is a positional argument; no --host-port/--ip/--vm-port flags; no -y.
 */
export async function addForward(
  hostPort: number,
  ip: string,
  vmPort: number,
  exec: PveExecutor = getPveExecutor(),
): Promise<void> {
  const spec = `${hostPort}:${ip}:${vmPort}`
  const argv = ["forward", spec, "--action", "add"]
  const result = await exec.run(argv)
  parseEnvelope(result, "forward add")
}

/**
 * List all active port-forward rules.
 *
 * Maps to: utils pve forward --action list
 * Returns raw iptables rule lines from data.rules (not structured objects).
 */
export async function listForward(
  exec: PveExecutor = getPveExecutor(),
): Promise<string[]> {
  const argv = ["forward", "--action", "list"]
  const result = await exec.run(argv)
  const data = parseEnvelope<{ rules: string[] }>(result, "forward list")
  return data.rules
}

// Raw shape returned by `utils pve status` before ip extraction.
interface StatusRaw {
  vmid: number
  name: string
  type?: string
  status?: string
  cores?: number
  hostname?: string
  memory?: unknown
  net0?: string       // "name=eth0,bridge=vmbr0,ip=10.10.10.201/24,..."
  onboot?: boolean
  rootfs?: string
}

/**
 * Get status of a container by name or VMID.
 *
 * Maps to: utils pve status <nameOrVmid>
 * Real data shape has ip embedded in net0 string — extracted via parseIpFromNet0.
 */
export async function status(
  nameOrVmid: string | number,
  exec: PveExecutor = getPveExecutor(),
): Promise<CtInfo> {
  const argv = ["status", String(nameOrVmid)]
  const result = await exec.run(argv)
  const raw = parseEnvelope<StatusRaw>(result, "status")
  const ip = raw.net0 ? parseIpFromNet0(raw.net0) : undefined
  return { vmid: raw.vmid, name: raw.name, status: raw.status, ip }
}

/**
 * List all containers managed by keel (2xx range).
 *
 * Maps to: utils pve list
 * data shape: [{vmid, name, status, mem_mb?, type}] — no ip field.
 */
export async function list(
  exec: PveExecutor = getPveExecutor(),
): Promise<CtInfo[]> {
  const argv = ["list"]
  const result = await exec.run(argv)
  // ip is absent from list output — callers that need ip must call status().
  return parseEnvelope<CtInfo[]>(result, "list")
}
