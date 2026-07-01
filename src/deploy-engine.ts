// deploy-engine.ts — Capistrano-style git-driven deploy for keel LXC services.
//
// WHY a separate file: the engine is tested with mock executors; it must have
// zero coupling to Bun.serve, DB, or any live infra call site.
//
// Security model:
//   - Every in-LXC command is a FIXED argv array.  The only interpolated values
//     are `name` (validated ^[a-z0-9][a-z0-9-]{0,62}$ in contract.ts) and `sha`
//     (validated ^[0-9a-f]{7,40}$ at deploy/rollback entry points).
//   - build.install / build.command are the ONE accepted-risk arbitrary-code
//     execution surfaces; they are explicitly marked and run inside the target
//     spoke LXC (blast radius = that LXC only).
//   - cloneToken is embedded into the clone URL argv element only; it is never
//     written to the result log or any state file.

import type { KeelConfig, Runtime } from "./contract.ts"

// ── Executor interface (dependency-injection surface) ─────────────────────────

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Abstraction over "run a command inside the target LXC".
 *
 * Production impl: SshLxcExecutor (see below).
 * Test impl: MockExecutor in __tests__/deploy-engine.test.ts.
 */
export interface LxcExecutor {
  run(lxc: string, argv: string[]): Promise<ExecResult>
}

// ── Result types ──────────────────────────────────────────────────────────────

export type DeployStatus = "success" | "failure" | "rolled_back"

export interface DeployResult {
  status: DeployStatus
  sha: string
  previousSha: string | null
  rolledBackTo: string | null   // set when auto-rollback fires
  log: string[]                 // ordered deploy step trace
}

// ── Shell quoting (fix #1) ────────────────────────────────────────────────────
//
// OpenSSH does NOT treat extra argv elements as separate words on the remote
// side.  When you run:
//
//   ssh host arg1 arg2 arg3
//
// OpenSSH concatenates them with spaces and passes the result to the remote
// login shell as a single string.  So passing ["sh", "-c", "cd /x && cmd"]
// as separate argv elements would arrive as `sh -c cd /x && cmd` — the remote
// shell parses that as `sh -c cd` followed by `/x && cmd`.
//
// The fix: single-quote every argv element (with internal single-quotes
// escaped via '\'' idiom) before joining, then pass the entire remote
// command as one SSH argument.  This is the POSIX-portable approach that
// works regardless of the remote shell.
//
// WHY exported: the quoting function is pure and independently unit-testable.

export function shellQuote(arg: string): string {
  // Replace every ' with '\'' (end quote, literal single-quote, reopen quote)
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ")
}

// ── Production executor (ssh into LXC) ───────────────────────────────────────

/**
 * SSH executor for real LXC targets.
 *
 * The LXC alias must be in ~/.ssh/config (keel bootstrap sets this up).
 * Port forward: 50<vmid>:22 — see keel plan §5 "bootstrap".
 *
 * Each run() builds a single quoted remote command string and passes it as
 * one argument to ssh so that argument boundaries are preserved correctly
 * on the remote side.
 */
export class SshLxcExecutor implements LxcExecutor {
  async run(lxc: string, argv: string[]): Promise<ExecResult> {
    const remoteCmd = buildRemoteCommand(argv)
    const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", lxc, remoteCmd], {
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

// ── Internal helpers ──────────────────────────────────────────────────────────

const RELEASES_KEEP = 3   // GC: keep newest N releases

// Allowed SHA format: 7-40 hex chars (git short or full SHA)
const SHA_RE = /^[0-9a-f]{7,40}$/

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new Error(`keel: sha '${sha}' must match ^[0-9a-f]{7,40}$ (git hex SHA)`)
  }
}

function releasesBase(name: string): string {
  return `/srv/${name}/releases`
}

function releaseDir(name: string, sha: string): string {
  return `${releasesBase(name)}/${sha}`
}

function currentLink(name: string): string {
  return `/srv/${name}/current`
}

function previousLink(name: string): string {
  return `/srv/${name}/previous`
}

function stateDir(name: string): string {
  return `/var/lib/keel/${name}`
}

/** Resolve what git SHA `current` symlink points to, or null if absent. */
async function readCurrentSha(
  exec: LxcExecutor,
  lxc: string,
  name: string,
): Promise<string | null> {
  const res = await exec.run(lxc, ["readlink", "-f", currentLink(name)])
  if (res.code !== 0) return null
  const target = res.stdout.trim()
  if (!target) return null
  // target looks like /srv/<name>/releases/<sha>
  const parts = target.split("/")
  return parts[parts.length - 1] ?? null
}

/** Run a shell command inside the release build_path — ACCEPTED RISK surface. */
async function runInBuildPath(
  exec: LxcExecutor,
  lxc: string,
  dir: string,
  cmd: string,
): Promise<ExecResult> {
  // ACCEPTED RISK: cmd is build.install or build.command from keel.yaml in the
  // target repo. Execution is constrained to the spoke LXC.
  // The sh -c wrapper is necessary to evaluate the build command string.
  return exec.run(lxc, ["sh", "-c", `cd ${dir} && ${cmd}`])
}

/**
 * Poll health from inside the target LXC using curl (fix #2).
 *
 * WHY curl-in-LXC instead of fetch() from keel:
 *   health.url is always `http://localhost:<port>/...` — "localhost" relative
 *   to the SERVICE LXC.  keel runs in its own LXC; a fetch() from here would
 *   hit keel's own loopback, not the service.  Running curl inside the target
 *   LXC via the executor resolves localhost correctly AND keeps health checking
 *   consistent with the executor abstraction already used everywhere else.
 *
 * The HealthChecker abstraction is removed; tests mock health via the same
 * MockExecutor they already use for everything else (curl verb → response).
 */
async function pollHealth(
  exec: LxcExecutor,
  lxc: string,
  url: string,
  timeoutSec: number,
  log: string[],
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  let attempts = 0
  while (Date.now() < deadline) {
    attempts++
    const res = await exec.run(lxc, [
      "curl", "-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", url,
    ])
    const httpCode = parseInt(res.stdout.trim(), 10)
    if (res.code === 0 && httpCode >= 200 && httpCode < 300) {
      log.push(`[health] ${url} → ${httpCode} after ${attempts} attempt(s)`)
      return true
    }
    await Bun.sleep(1000)
  }
  log.push(`[health] ${url} timed out after ${timeoutSec}s (${attempts} attempts)`)
  return false
}

/** Remove a release directory. Best-effort — log but don't throw. */
async function rmRelease(
  exec: LxcExecutor,
  lxc: string,
  name: string,
  sha: string,
  log: string[],
): Promise<void> {
  const dir = releaseDir(name, sha)
  const res = await exec.run(lxc, ["rm", "-rf", dir])
  if (res.code !== 0) {
    log.push(`[gc] warning: could not remove ${dir}: ${res.stderr.trim()}`)
  } else {
    log.push(`[gc] removed ${dir}`)
  }
}

/** GC: keep the newest RELEASES_KEEP releases under /srv/<name>/releases. */
async function gcReleases(
  exec: LxcExecutor,
  lxc: string,
  name: string,
  log: string[],
): Promise<void> {
  // List release dirs sorted by mtime (oldest first)
  const res = await exec.run(lxc, [
    "find", releasesBase(name), "-maxdepth", "1", "-mindepth", "1", "-type", "d",
    "-printf", "%T@ %f\n",
  ])
  if (res.code !== 0) return

  const entries = res.stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [ts, ...rest] = l.split(" ")
      return { ts: parseFloat(ts ?? "0"), sha: rest.join(" ") }
    })
    .sort((a, b) => a.ts - b.ts)  // oldest first

  if (entries.length <= RELEASES_KEEP) return

  const toRemove = entries.slice(0, entries.length - RELEASES_KEEP)
  for (const e of toRemove) {
    await rmRelease(exec, lxc, name, e.sha, log)
  }
}

/** Write a SHA to a state file in /var/lib/keel/<name>/<file>. */
async function writeStateFile(
  exec: LxcExecutor,
  lxc: string,
  name: string,
  file: "current" | "previous",
  sha: string,
  log: string[],
): Promise<void> {
  const dir = stateDir(name)
  await exec.run(lxc, ["mkdir", "-p", dir])
  const path = `${dir}/${file}`
  // Use tee with a single-element argv; sha is validated hex so no shell risk,
  // but we pass it via echo pipe through sh to avoid the need for a separate
  // "write" program that isn't universally available.
  const res = await exec.run(lxc, ["sh", "-c", `printf '%s' ${sha} > ${path}`])
  if (res.code !== 0) {
    log.push(`[state] warning: could not write ${path}: ${res.stderr.trim()}`)
  }
}

/** Append a line to /var/lib/keel/<name>/deploy.log. */
async function appendDeployLog(
  exec: LxcExecutor,
  lxc: string,
  name: string,
  line: string,
): Promise<void> {
  const path = `${stateDir(name)}/deploy.log`
  await exec.run(lxc, ["sh", "-c", `mkdir -p ${stateDir(name)} && printf '%s\\n' "${line}" >> ${path}`])
}

// ── ensureRuntime — idempotent toolchain bootstrap ───────────────────────────
//
// WHY here (not in provision): provision runs on PVE (via utils pve create-ct).
// The target LXC starts as a bare Ubuntu image. The deploy-engine is the only
// component that SSHs into the target LXC, so toolchain bootstrap lives here.
//
// Idempotency: each installer is gated by a `which <binary>` check.
// If the binary already exists, the installation block is skipped entirely.
//
// [ACCEPTED-RISK] We run the official vendor install scripts over HTTPS
// (bun.sh/install, setup_*.x script from nodesource, astral-sh/uv installer).
// This is standard practice for Bun / Node / uv. The LXC has firewall rules
// limiting outbound to known hosts (configured at provision time).

export async function ensureRuntime(
  exec: LxcExecutor,
  lxc: string,
  runtime: Runtime,
  log: string[],
): Promise<boolean> {
  // Ensure base utilities are present (git clone, curl for install scripts, unzip for bun)
  const baseCheck = await exec.run(lxc, ["sh", "-c",
    "dpkg -l git curl unzip 2>/dev/null | grep -c '^ii' | grep -q '3' && echo ok || apt-get install -y git curl unzip",
  ])
  if (baseCheck.code !== 0) {
    log.push(`[runtime] WARNING: could not ensure base tools: ${baseCheck.stderr.trim()}`)
    // Non-fatal: continue — maybe they're already installed differently
  } else {
    log.push(`[runtime] base tools (git/curl/unzip) ok`)
  }

  if (runtime === "static") {
    log.push(`[runtime] static — no toolchain needed`)
    return true
  }

  if (runtime === "bun") {
    // Check if bun is already installed
    const check = await exec.run(lxc, ["sh", "-c", "which bun >/dev/null 2>&1 && echo installed"])
    if (check.code === 0 && check.stdout.includes("installed")) {
      log.push(`[runtime] bun already installed — skip`)
      return true
    }
    log.push(`[runtime] installing bun...`)
    const install = await exec.run(lxc, ["sh", "-c",
      "curl -fsSL https://bun.sh/install | bash && ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun",
    ])
    if (install.code !== 0) {
      log.push(`[runtime] bun install FAILED: ${install.stderr.trim()}`)
      return false
    }
    log.push(`[runtime] bun installed ok`)
    return true
  }

  if (runtime === "node") {
    const check = await exec.run(lxc, ["sh", "-c", "which node >/dev/null 2>&1 && echo installed"])
    if (check.code === 0 && check.stdout.includes("installed")) {
      log.push(`[runtime] node already installed — skip`)
      return true
    }
    log.push(`[runtime] installing node via nodesource...`)
    const install = await exec.run(lxc, ["sh", "-c",
      "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
    ])
    if (install.code !== 0) {
      log.push(`[runtime] node install FAILED: ${install.stderr.trim()}`)
      return false
    }
    log.push(`[runtime] node installed ok`)
    return true
  }

  if (runtime === "python") {
    const check = await exec.run(lxc, ["sh", "-c", "which uv >/dev/null 2>&1 && echo installed"])
    if (check.code === 0 && check.stdout.includes("installed")) {
      log.push(`[runtime] uv already installed — skip`)
      return true
    }
    log.push(`[runtime] installing uv...`)
    const install = await exec.run(lxc, ["sh", "-c",
      "curl -LsSf https://astral.sh/uv/install.sh | sh && ln -sf $HOME/.local/bin/uv /usr/local/bin/uv",
    ])
    if (install.code !== 0) {
      log.push(`[runtime] uv install FAILED: ${install.stderr.trim()}`)
      return false
    }
    log.push(`[runtime] uv installed ok`)
    return true
  }

  log.push(`[runtime] unknown runtime '${runtime}' — skipping toolchain bootstrap`)
  return true
}

// ── Generate systemd unit content ─────────────────────────────────────────────

function buildSystemdUnit(config: KeelConfig, sha: string): string {
  const { name, env_file, run, port } = config
  const buildPath = config.repo.build_path
  const workingDir = buildPath === "."
    ? currentLink(name)
    : `${currentLink(name)}/${buildPath}`

  const execStart = run.command ?? ""

  // WHY: EnvironmentFile keeps secrets off the process cmdline; /etc/keel/<name>.env
  //      is 600 root-owned on the LXC, managed by sops/scp (V2).
  const lines = [
    `[Unit]`,
    `Description=keel managed service: ${name} (${sha})`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${workingDir}`,
    `EnvironmentFile=${env_file}`,
    `ExecStart=${execStart}`,
    `Restart=on-failure`,
    `RestartSec=5`,
    // Expose PORT so the app can bind the right port without hardcoding
    `Environment=PORT=${port}`,
  ]

  // WHY: ports <1024 need CAP_NET_BIND_SERVICE — unprivileged LXC users can't
  //      bind them otherwise. Ambient cap avoids running the whole unit as root.
  if (port < 1024) {
    lines.push(`AmbientCapabilities=CAP_NET_BIND_SERVICE`)
  }

  lines.push(``, `[Install]`, `WantedBy=multi-user.target`)

  return lines.join("\n")
}

// ── Core: performSwap ─────────────────────────────────────────────────────────
//
// Atomic symlink swap:
//   1. capture old current → previous
//   2. ln -sfn <new_release> current.new   (atomic creation of a new symlink)
//   3. mv -Tf current.new current          (atomic rename)
//
// Using mv -Tf instead of ln -sfn directly on `current` because on some Linux
// filesystems rename(2) (mv -T) is guaranteed atomic while ln -sfn on an
// existing target has a small TOCTOU window.

async function performSwap(
  exec: LxcExecutor,
  lxc: string,
  name: string,
  sha: string,
  log: string[],
): Promise<void> {
  const newRelease = releaseDir(name, sha)
  const current = currentLink(name)
  const previous = previousLink(name)
  const tmpLink = `/srv/${name}/current.new`

  // Capture old current → previous (best-effort)
  const old = await exec.run(lxc, ["readlink", current])
  if (old.code === 0 && old.stdout.trim()) {
    await exec.run(lxc, ["ln", "-sfn", old.stdout.trim(), previous])
    log.push(`[swap] previous → ${old.stdout.trim()}`)
  }

  // Atomic swap
  await exec.run(lxc, ["ln", "-sfn", newRelease, tmpLink])
  const mv = await exec.run(lxc, ["mv", "-Tf", tmpLink, current])
  if (mv.code !== 0) {
    throw new Error(`[swap] mv -Tf failed: ${mv.stderr.trim()}`)
  }
  log.push(`[swap] current → ${newRelease}`)
}

// ── deploy() ─────────────────────────────────────────────────────────────────

export interface DeployOpts {
  lxc: string
  sha: string
  repoUrl: string        // e.g. https://github.com/zyx1121/danmu
  cloneToken?: string    // GitHub App install token or PAT (not logged)
  branch?: string        // defaults to "main"
}

/**
 * Deploy a service into a target LXC.
 *
 * Steps (§3 of keel plan V1.4):
 *  1. Ensure /srv/<name>/{releases,shared} dirs exist
 *  2. git clone --depth 1 into releases/<sha>
 *  3. build.install + build.command in build_path (ACCEPTED RISK)
 *  4. Ensure env_file exists; write systemd unit (skipped for static)
 *  5. performSwap (current → previous, atomic symlink)
 *  6. systemctl restart <name>  (skipped for static)
 *  7. health-poll (curl inside target LXC)
 *  8. On failure: swap back to previous, restart, re-poll; mark rolled_back
 *  9. GC releases (keep 3)
 */
export async function deploy(
  config: KeelConfig,
  opts: DeployOpts,
  exec: LxcExecutor = new SshLxcExecutor(),
): Promise<DeployResult> {
  const { name, runtime, build, health: healthCfg } = config
  const { lxc, sha, repoUrl, cloneToken, branch = "main" } = opts
  const log: string[] = []
  const isStatic = runtime === "static"

  // ── Validate SHA (security: sha is interpolated into state file paths) ──────
  try {
    assertSha(sha)
  } catch (e) {
    return { status: "failure", sha, previousSha: null, rolledBackTo: null, log: [(e as Error).message] }
  }

  // ── Capture previous SHA for rollback ───────────────────────────────────────
  const previousSha = await readCurrentSha(exec, lxc, name)
  log.push(`[deploy] start sha=${sha} previous=${previousSha ?? "none"} lxc=${lxc}`)

  // ── Step 0: ensure runtime toolchain is installed ───────────────────────────
  const runtimeOk = await ensureRuntime(exec, lxc, runtime, log)
  if (!runtimeOk) {
    log.push(`[deploy] ABORTED: runtime bootstrap failed for '${runtime}'`)
    return { status: "failure", sha, previousSha: null, rolledBackTo: null, log }
  }

  // ── Step 1: ensure release dirs ─────────────────────────────────────────────
  const relBase = releasesBase(name)
  await exec.run(lxc, ["mkdir", "-p", relBase, `/srv/${name}/shared`])
  log.push(`[dirs] ${relBase} ready`)

  // ── Step 2: git clone ────────────────────────────────────────────────────────
  // Embed token into URL only if provided; token is NOT logged.
  let cloneUrl = repoUrl
  if (cloneToken) {
    // https://x-access-token:<token>@github.com/...
    cloneUrl = repoUrl.replace("https://", `https://x-access-token:${cloneToken}@`)
  }
  const cloneRes = await exec.run(lxc, [
    "git", "clone", "--depth", "1", "--branch", branch, cloneUrl, releaseDir(name, sha),
  ])
  if (cloneRes.code !== 0) {
    log.push(`[clone] FAILED: ${cloneRes.stderr.trim()}`)
    return { status: "failure", sha, previousSha, rolledBackTo: null, log }
  }
  log.push(`[clone] ok → ${releaseDir(name, sha)}`)

  // ── Step 3: build ─────────────────────────────────────────────────────────
  const buildDir = config.repo.build_path === "."
    ? releaseDir(name, sha)
    : `${releaseDir(name, sha)}/${config.repo.build_path}`

  if (build.install) {
    // ACCEPTED RISK: arbitrary command from keel.yaml, runs inside spoke LXC
    const installRes = await runInBuildPath(exec, lxc, buildDir, build.install)
    if (installRes.code !== 0) {
      log.push(`[build] install FAILED: ${installRes.stderr.trim()}`)
      await rmRelease(exec, lxc, name, sha, log)
      return { status: "failure", sha, previousSha, rolledBackTo: null, log }
    }
    log.push(`[build] install ok`)
  }

  if (build.command) {
    // ACCEPTED RISK: same as above
    const buildRes = await runInBuildPath(exec, lxc, buildDir, build.command)
    if (buildRes.code !== 0) {
      log.push(`[build] command FAILED: ${buildRes.stderr.trim()}`)
      await rmRelease(exec, lxc, name, sha, log)
      return { status: "failure", sha, previousSha, rolledBackTo: null, log }
    }
    log.push(`[build] command ok`)
  }

  // ── Step 4: ensure env_file; write systemd unit ────────────────────────────
  if (!isStatic) {
    // Touch env_file if absent (operator populates it via sops/scp in V2)
    await exec.run(lxc, ["sh", "-c", `[ -f ${config.env_file} ] || touch ${config.env_file}`])

    const unitContent = buildSystemdUnit(config, sha)
    const unitPath = `/etc/systemd/system/${name}.service`
    const writeUnit = await exec.run(lxc, [
      "sh", "-c", `cat > ${unitPath} << 'KEEL_UNIT_EOF'\n${unitContent}\nKEEL_UNIT_EOF`,
    ])
    if (writeUnit.code !== 0) {
      log.push(`[systemd] warning: could not write unit to ${unitPath}: ${writeUnit.stderr.trim()}`)
    } else {
      log.push(`[systemd] wrote ${unitPath}`)
    }
    await exec.run(lxc, ["systemctl", "daemon-reload"])
    // Enable the service so it auto-starts on boot (idempotent — enable is safe to
    // call on an already-enabled unit; daemon-reload must come first).
    const enableRes = await exec.run(lxc, ["systemctl", "enable", name])
    if (enableRes.code !== 0) {
      log.push(`[systemd] warning: could not enable ${name}: ${enableRes.stderr.trim()}`)
    } else {
      log.push(`[systemd] enabled ${name} (boot auto-start)`)
    }
  }

  // ── Step 5: atomic symlink swap ────────────────────────────────────────────
  try {
    await performSwap(exec, lxc, name, sha, log)
  } catch (e) {
    log.push(`[swap] FAILED: ${(e as Error).message}`)
    await rmRelease(exec, lxc, name, sha, log)
    return { status: "failure", sha, previousSha, rolledBackTo: null, log }
  }

  // ── Step 6: restart service ────────────────────────────────────────────────
  if (!isStatic) {
    const restartRes = await exec.run(lxc, ["systemctl", "restart", name])
    if (restartRes.code !== 0) {
      log.push(`[restart] FAILED: ${restartRes.stderr.trim()}`)
      // Fall through to health poll; it will detect the failure
    } else {
      log.push(`[restart] systemctl restart ${name} ok`)
    }
  }

  // ── Step 7: health poll (curl inside target LXC) ──────────────────────────
  const healthy = await pollHealth(exec, lxc, healthCfg.url, healthCfg.timeout, log)

  if (healthy) {
    // SUCCESS path
    await writeStateFile(exec, lxc, name, "current", sha, log)
    if (previousSha) {
      await writeStateFile(exec, lxc, name, "previous", previousSha, log)
    }
    await appendDeployLog(
      exec, lxc, name,
      `${new Date().toISOString()} deploy sha=${sha} status=success`,
    )
    log.push(`[deploy] SUCCESS sha=${sha}`)
    await gcReleases(exec, lxc, name, log)
    return { status: "success", sha, previousSha, rolledBackTo: null, log }
  }

  // ── Step 8: health failed → auto-rollback to previous ─────────────────────
  log.push(`[rollback] health failed → attempting rollback to ${previousSha ?? "none"}`)

  if (!previousSha) {
    log.push(`[rollback] no previous SHA — cannot rollback`)
    await appendDeployLog(
      exec, lxc, name,
      `${new Date().toISOString()} deploy sha=${sha} status=failure (no previous to rollback)`,
    )
    return { status: "failure", sha, previousSha: null, rolledBackTo: null, log }
  }

  // Swap current → previous release
  try {
    await performSwap(exec, lxc, name, previousSha, log)
  } catch (e) {
    log.push(`[rollback] swap FAILED: ${(e as Error).message}`)
    return { status: "failure", sha, previousSha, rolledBackTo: null, log }
  }

  if (!isStatic) {
    await exec.run(lxc, ["systemctl", "restart", name])
    log.push(`[rollback] restarted ${name}`)
  }

  const rollbackHealthy = await pollHealth(exec, lxc, healthCfg.url, healthCfg.timeout, log)

  await writeStateFile(exec, lxc, name, "current", previousSha, log)
  await appendDeployLog(
    exec, lxc, name,
    `${new Date().toISOString()} deploy sha=${sha} status=rolled_back to=${previousSha}`,
  )
  await gcReleases(exec, lxc, name, log)

  if (rollbackHealthy) {
    log.push(`[rollback] SUCCESS: service restored to ${previousSha}`)
    return { status: "rolled_back", sha, previousSha, rolledBackTo: previousSha, log }
  } else {
    log.push(`[rollback] re-poll FAILED: service may be degraded`)
    return { status: "failure", sha, previousSha, rolledBackTo: previousSha, log }
  }
}

// ── rollback() ───────────────────────────────────────────────────────────────

export interface RollbackOpts {
  lxc: string
  toSha?: string   // explicit SHA; omit to roll back to `previous`
}

/**
 * Manual rollback: swap current to a specific or previous SHA, restart, re-poll.
 */
export async function rollback(
  config: KeelConfig,
  opts: RollbackOpts,
  exec: LxcExecutor = new SshLxcExecutor(),
): Promise<DeployResult> {
  const { name, runtime, health: healthCfg } = config
  const { lxc } = opts
  const log: string[] = []
  const isStatic = runtime === "static"

  // Validate explicit SHA if provided
  if (opts.toSha) {
    try {
      assertSha(opts.toSha)
    } catch (e) {
      return { status: "failure", sha: "unknown", previousSha: null, rolledBackTo: null, log: [(e as Error).message] }
    }
  }

  const currentSha = await readCurrentSha(exec, lxc, name)
  log.push(`[rollback] current=${currentSha ?? "none"} lxc=${lxc}`)

  // Resolve target SHA
  let targetSha = opts.toSha
  if (!targetSha) {
    // Read from /var/lib/keel/<name>/previous
    const res = await exec.run(lxc, ["cat", `${stateDir(name)}/previous`])
    if (res.code !== 0 || !res.stdout.trim()) {
      log.push(`[rollback] no previous SHA recorded — cannot rollback`)
      return { status: "failure", sha: currentSha ?? "unknown", previousSha: null, rolledBackTo: null, log }
    }
    targetSha = res.stdout.trim()
    // Validate the SHA we just read from disk
    try {
      assertSha(targetSha)
    } catch (e) {
      log.push(`[rollback] invalid SHA in state file: ${(e as Error).message}`)
      return { status: "failure", sha: currentSha ?? "unknown", previousSha: null, rolledBackTo: null, log }
    }
  }

  log.push(`[rollback] target sha=${targetSha}`)

  // Verify target release exists
  const checkDir = await exec.run(lxc, ["test", "-d", releaseDir(name, targetSha)])
  if (checkDir.code !== 0) {
    log.push(`[rollback] release ${releaseDir(name, targetSha)} does not exist`)
    return { status: "failure", sha: currentSha ?? "unknown", previousSha: targetSha, rolledBackTo: null, log }
  }

  try {
    await performSwap(exec, lxc, name, targetSha, log)
  } catch (e) {
    log.push(`[rollback] swap FAILED: ${(e as Error).message}`)
    return { status: "failure", sha: currentSha ?? "unknown", previousSha: targetSha, rolledBackTo: null, log }
  }

  if (!isStatic) {
    await exec.run(lxc, ["systemctl", "restart", name])
    log.push(`[rollback] restarted ${name}`)
  }

  const healthy = await pollHealth(exec, lxc, healthCfg.url, healthCfg.timeout, log)

  await writeStateFile(exec, lxc, name, "current", targetSha, log)
  await appendDeployLog(
    exec, lxc, name,
    `${new Date().toISOString()} manual-rollback to=${targetSha} status=${healthy ? "success" : "failure"}`,
  )

  if (healthy) {
    log.push(`[rollback] SUCCESS: restored to ${targetSha}`)
    return {
      status: "rolled_back",
      sha: currentSha ?? "unknown",
      previousSha: currentSha ?? null,
      rolledBackTo: targetSha,
      log,
    }
  } else {
    log.push(`[rollback] health poll FAILED after rollback`)
    return {
      status: "failure",
      sha: currentSha ?? "unknown",
      previousSha: currentSha ?? null,
      rolledBackTo: targetSha,
      log,
    }
  }
}
