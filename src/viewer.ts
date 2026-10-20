import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { procAlive, type Runner } from './exec.ts';
import { readState, withState } from './state.ts';
import { mayControl } from './pool.ts';

/** scrcpy is pinned: a version and its published SHA-256 per macOS build. */
export const SCRCPY_VERSION = 'v5.0.1';
const SCRCPY_SHA256: Record<string, string> = {
  aarch64: '33611e51977a8289e2e124b220f727895181ef2eb9060e0987a4dc2db9cf0d6b',
  x86_64: '31a5467a9e907f162b093267cbbab1276b15c6e709c2ea8159566a8d165beb50',
};

export interface ViewerOpts {
  /** Node's process.arch; defaults to the running process. */
  arch?: string;
  /** Overrides the pinned checksums (tests). */
  checksums?: Record<string, string>;
  download?: (url: string) => Promise<Buffer>;
  log?: (msg: string) => void;
  /** When set (MCP), only the owning session, or anyone once the owner is gone, may show the device. */
  requireOwnerPid?: number;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The release tarballs are about 5 MB; anything far larger is not what we pinned. */
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

function scrcpyArch(arch: string): string {
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'x64') return 'x86_64';
  throw new Error(`no scrcpy build for arch ${arch}`);
}

function releaseName(arch: string): string {
  return `scrcpy-macos-${scrcpyArch(arch)}-${SCRCPY_VERSION}`;
}

export function scrcpyDir(cfg: Config, arch: string = process.arch): string {
  return path.join(cfg.home, 'tools', releaseName(arch));
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`scrcpy download failed: HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > DOWNLOAD_MAX_BYTES) throw new Error(`scrcpy download too large: ${len} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > DOWNLOAD_MAX_BYTES) throw new Error(`scrcpy download too large: ${bytes.length} bytes`);
  return bytes;
}

/**
 * Returns the path of the pinned scrcpy binary, downloading the official release on first use.
 * Homebrew is not used: an Intel Homebrew on Apple Silicon builds scrcpy's deps from source and fails.
 */
export async function ensureScrcpy(runner: Runner, cfg: Config, opts: ViewerOpts = {}): Promise<string> {
  const arch = opts.arch ?? process.arch;
  const dir = scrcpyDir(cfg, arch);
  const bin = path.join(dir, 'scrcpy');
  if (fs.existsSync(bin)) return bin;
  if (process.platform !== 'darwin') throw new Error('droidpool show supports macOS only');

  const name = releaseName(arch);
  const url = `https://github.com/Genymobile/scrcpy/releases/download/${SCRCPY_VERSION}/${name}.tar.gz`;
  opts.log?.(`downloading scrcpy ${SCRCPY_VERSION} (one time)`);
  const bytes = await (opts.download ?? fetchBytes)(url);
  const want = (opts.checksums ?? SCRCPY_SHA256)[scrcpyArch(arch)];
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`scrcpy download checksum mismatch: expected ${want}, got ${got}`);

  // Unpack into a private staging dir and rename it into place, so `dir` only ever appears
  // complete and concurrent installs never touch each other's files.
  const toolsDir = path.dirname(dir);
  fs.mkdirSync(toolsDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(toolsDir, `.staging-${process.pid}-`));
  try {
    const tarball = path.join(staging, `${name}.tar.gz`);
    fs.writeFileSync(tarball, bytes);
    const r = await runner.run('tar', ['-xzf', tarball, '-C', staging], { timeoutMs: 60_000 });
    const staged = path.join(staging, name);
    if (r.code !== 0 || !fs.existsSync(path.join(staged, 'scrcpy'))) {
      throw new Error(`scrcpy unpack failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    try {
      fs.renameSync(staged, dir);
    } catch (e) {
      // Another install finished first; use its copy.
      if (!fs.existsSync(bin)) throw e;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return bin;
}

/** Opens a scrcpy mirror window on a ready device; one window per device. */
export async function showDevice(runner: Runner, cfg: Config, serial: string, opts: ViewerOpts = {}): Promise<string> {
  const lease = readState(cfg.stateFile).leases.find((l) => l.serial === serial);
  if (!lease) throw new Error(`no device ${serial}`);
  if (lease.state === 'booting') throw new Error(`device ${serial} is still booting`);
  if (opts.requireOwnerPid !== undefined && !mayControl(runner, lease.owner, opts.requireOwnerPid, Date.now())) {
    throw new Error(`device ${serial} belongs to another session`);
  }
  const showing = (l: { viewerPid?: number; viewerStart?: string }) =>
    l.viewerPid !== undefined && procAlive(runner, l.viewerPid, l.viewerStart);
  if (showing(lease)) return `already showing ${serial}`;

  const bin = await ensureScrcpy(runner, cfg, opts);
  const title = `${serial} (${path.basename(lease.project)})`;
  const pid = runner.spawnDetached(bin, ['-s', serial, '--window-title', title, '--no-audio'], {
    // Use the SDK adb so scrcpy does not start its bundled adb server and fight over the port.
    env: { ...process.env, ADB: cfg.adbBin },
    logFile: path.join(cfg.logsDir, `${lease.deviceId}-scrcpy.log`),
  });
  const viewerStart = runner.startTime(pid);
  // Re-checked under the lock: a concurrent show may have recorded its window first, and a
  // release that drops the lease after this point closes the window recorded here.
  const recorded = await withState(cfg.stateFile, (s): 'ok' | 'gone' | 'other' => {
    const l = s.leases.find((x) => x.deviceId === lease.deviceId);
    if (!l) return 'gone';
    if (showing(l)) return 'other';
    l.viewerPid = pid;
    if (viewerStart !== undefined) l.viewerStart = viewerStart;
    else delete l.viewerStart;
    return 'ok';
  });
  if (recorded !== 'ok') {
    runner.kill(pid, 'SIGTERM', { group: true });
    if (recorded === 'other') return `already showing ${serial}`;
    throw new Error(`no device ${serial}`);
  }
  return `showing ${serial} in a window titled "${title}"`;
}
