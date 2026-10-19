import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Runner } from './exec.ts';
import { readState, withState } from './state.ts';

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
}

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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scrcpy download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
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

  const toolsDir = path.dirname(dir);
  fs.mkdirSync(toolsDir, { recursive: true });
  const tarball = path.join(toolsDir, `${name}.tar.gz`);
  fs.writeFileSync(tarball, bytes);
  try {
    const r = await runner.run('tar', ['-xzf', tarball, '-C', toolsDir], { timeoutMs: 60_000 });
    if (r.code !== 0 || !fs.existsSync(bin)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`scrcpy unpack failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  } finally {
    fs.rmSync(tarball, { force: true });
  }
  return bin;
}

/** Opens a scrcpy mirror window on a ready device; one window per device. */
export async function showDevice(runner: Runner, cfg: Config, serial: string, opts: ViewerOpts = {}): Promise<string> {
  const lease = readState(cfg.stateFile).leases.find((l) => l.serial === serial);
  if (!lease) throw new Error(`no device ${serial}`);
  if (lease.state === 'booting') throw new Error(`device ${serial} is still booting`);
  if (lease.viewerPid !== undefined && runner.isAlive(lease.viewerPid)) return `already showing ${serial}`;

  const bin = await ensureScrcpy(runner, cfg, opts);
  const title = `${serial} (${path.basename(lease.project)})`;
  const pid = runner.spawnDetached(bin, ['-s', serial, '--window-title', title, '--no-audio'], {
    // Use the SDK adb so scrcpy does not start its bundled adb server and fight over the port.
    env: { ...process.env, ADB: cfg.adbBin },
    logFile: path.join(cfg.logsDir, `${lease.deviceId}-scrcpy.log`),
  });
  const recorded = await withState(cfg.stateFile, (s) => {
    const l = s.leases.find((x) => x.deviceId === lease.deviceId);
    if (!l) return false;
    l.viewerPid = pid;
    return true;
  });
  if (!recorded) {
    runner.kill(pid, 'SIGTERM');
    throw new Error(`no device ${serial}`);
  }
  return `showing ${serial} in a window titled "${title}"`;
}
