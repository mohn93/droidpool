import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './exec.ts';
import { ensureDirs, type Config } from './config.ts';
import { deviceIni, rewriteHardwareIni } from './avdfiles.ts';
import { readState, withState, type Flavor, type Lease, type Owner, type State } from './state.ts';
import { assertDiskOk, cloneDir } from './disk.ts';
import { pickPort } from './ports.ts';
import { assertBaseUsable } from './base.ts';
import { killDevice, launchDevice, waitBoot } from './emulator.ts';

export interface DeviceInfo {
  serial: string;
  deviceId: string;
  flavor: Flavor;
  api: number;
  project: string;
  owner: Owner;
  state: Lease['state'];
}

export const POOL_FULL_MESSAGE =
  'device pool is full (max <n>). Do not start an emulator yourself; retry later or ask the user to release a device.';

export function poolFullMessage(n: number): string {
  return POOL_FULL_MESSAGE.replace('<n>', String(n));
}

const DEFAULT_API = 35;
/** Extra slack past bootTimeoutMs before a 'booting' lease is presumed abandoned by its getter. */
const BOOTING_GRACE_MS = 60_000;
const DEVICE_FILE_RE = /^(dev-[^/]+)\.(avd|ini)$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toInfo(l: Lease): DeviceInfo {
  return {
    serial: l.serial,
    deviceId: l.deviceId,
    flavor: l.flavor,
    api: l.api,
    project: l.project,
    owner: { ...l.owner },
    state: l.state,
  };
}

const devDir = (cfg: Config, id: string) => path.join(cfg.avdHome, `${id}.avd`);
const devIni = (cfg: Config, id: string) => path.join(cfg.avdHome, `${id}.ini`);

// pid 0 is the placeholder for "not launched yet"; never probe or signal it.
const pidAlive = (runner: Runner, pid: number) => pid > 0 && runner.isAlive(pid);

function removeDeviceFiles(cfg: Config, id: string): void {
  fs.rmSync(devDir(cfg, id), { recursive: true, force: true });
  fs.rmSync(devIni(cfg, id), { force: true });
}

/** Kill the emulator if alive and remove its files. The caller removes the lease afterwards. */
async function teardown(runner: Runner, cfg: Config, l: Lease): Promise<void> {
  if (pidAlive(runner, l.emulatorPid)) await killDevice(runner, cfg, l.serial, l.emulatorPid);
  removeDeviceFiles(cfg, l.deviceId);
}

async function dropLeases(cfg: Config, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  await withState(cfg.stateFile, (s) => {
    s.leases = s.leases.filter((l) => !drop.has(l.deviceId));
  });
}

function newDeviceId(cfg: Config, s: State): string {
  for (;;) {
    const id = `dev-${crypto.randomBytes(3).toString('hex')}`;
    if (s.leases.some((l) => l.deviceId === id)) continue;
    if (fs.existsSync(devDir(cfg, id)) || fs.existsSync(devIni(cfg, id))) continue;
    return id;
  }
}

/**
 * reuseSerial decision, run under the state lock. Returns the device to hand back, or
 * undefined to fall through to a fresh device. Adoption also requires the lease to be
 * outside every reap condition, so a concurrent reaper cannot be tearing it down.
 */
function tryAdopt(
  runner: Runner,
  cfg: Config,
  l: Lease,
  req: { flavor: Flavor; project: string },
  api: number,
  owner: Owner,
  now: number,
): DeviceInfo | undefined {
  if (l.state === 'booting') throw new Error(`device ${l.serial} is still booting`);
  const o = l.owner;
  if (o.kind === 'mcp' && owner.kind === 'mcp' && o.pid === owner.pid) return toInfo(l);
  if (l.flavor !== req.flavor || l.api !== api) return undefined;
  if (o.kind === 'cli' || (o.goneSince === undefined && runner.isAlive(o.pid))) {
    throw new Error(`device ${l.serial} is owned by another live session`);
  }
  const withinGrace = o.goneSince === undefined || now - o.goneSince <= cfg.ownerGraceMs;
  if (!withinGrace || !pidAlive(runner, l.emulatorPid)) return undefined;
  l.owner = owner;
  l.project = req.project;
  return toInfo(l);
}

export async function getDevice(
  runner: Runner,
  cfg: Config,
  req: { flavor: Flavor; api?: number; project: string; owner: Owner; reuseSerial?: string },
): Promise<DeviceInfo> {
  ensureDirs(cfg);
  const api = req.api ?? DEFAULT_API;
  const owner: Owner = req.owner.kind === 'mcp' ? { kind: 'mcp', pid: req.owner.pid } : { ...req.owner };
  await reap(runner, cfg);

  if (req.reuseSerial !== undefined) {
    const serial = req.reuseSerial;
    const adopted = await withState(cfg.stateFile, (s) => {
      const l = s.leases.find((x) => x.serial === serial);
      return l ? tryAdopt(runner, cfg, l, req, api, owner, Date.now()) : undefined;
    });
    if (adopted) return adopted;
  }

  const base = await assertBaseUsable(runner, cfg, req.flavor, api);
  const baseDir = devDir(cfg, base.name);

  const deadline = Date.now() + cfg.queueWaitMs;
  let lease: Lease;
  for (;;) {
    const got = await withState(cfg.stateFile, (s): Lease | null => {
      if (s.leases.length >= cfg.maxDevices) return null;
      assertDiskOk(cfg, cfg.freeBytesFn(cfg.home));
      const port = pickPort(cfg, new Set(s.leases.map((l) => l.port)));
      if (port === null) throw new Error('no free emulator port');
      const l: Lease = {
        deviceId: newDeviceId(cfg, s),
        serial: `emulator-${port}`,
        port,
        emulatorPid: 0,
        flavor: req.flavor,
        api,
        project: req.project,
        owner,
        createdAt: Date.now(),
        state: 'booting',
      };
      s.leases.push(l);
      return l;
    });
    if (got) {
      lease = got;
      break;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(poolFullMessage(cfg.maxDevices));
    await sleep(Math.min(cfg.queuePollMs, left));
    await reap(runner, cfg);
  }

  const { deviceId: id, serial } = lease;
  const dir = devDir(cfg, id);
  let pid = 0;
  try {
    await cloneDir(runner, baseDir, dir, cfg.cloneProbe);
    fs.rmSync(path.join(dir, 'multiinstance.lock'), { force: true });
    fs.rmSync(path.join(dir, 'hardware-qemu.ini'), { force: true });
    const hwIni = path.join(dir, 'snapshots', 'default_boot', 'hardware.ini');
    fs.writeFileSync(hwIni, rewriteHardwareIni(fs.readFileSync(hwIni, 'utf8'), base.name, baseDir, id, dir));
    fs.writeFileSync(devIni(cfg, id), deviceIni(dir, api));

    pid = launchDevice(runner, cfg, id, lease.port);
    await updateLease(cfg, id, (l) => {
      l.emulatorPid = pid;
    });
    await waitBoot(runner, cfg, serial, pid, path.join(cfg.logsDir, `${id}.log`), cfg.bootPollMs);
    return await updateLease(cfg, id, (l) => {
      l.state = 'ready';
    });
  } catch (e) {
    try {
      const stillLeased = await withState(cfg.stateFile, (s) => s.leases.some((l) => l.deviceId === id));
      if (stillLeased) {
        await teardown(runner, cfg, { ...lease, emulatorPid: pid });
        await dropLeases(cfg, [id]);
      } else {
        // Our lease was reaped, so its serial may already belong to another device: never `emu kill` it.
        if (pidAlive(runner, pid)) runner.kill(pid, 'SIGKILL');
        removeDeviceFiles(cfg, id);
      }
    } catch {
      // best effort; reap retries, and the original error matters more
    }
    throw e;
  }
}

async function updateLease(cfg: Config, id: string, fn: (l: Lease) => void): Promise<DeviceInfo> {
  return withState(cfg.stateFile, (s) => {
    const l = s.leases.find((x) => x.deviceId === id);
    if (!l) throw new Error(`device ${id} was released while booting`);
    fn(l);
    return toInfo(l);
  });
}

export async function releaseDevice(
  runner: Runner,
  cfg: Config,
  serial: string,
  opts: { requireOwnerPid?: number } = {},
): Promise<{ released: boolean; message: string }> {
  const l = await withState(cfg.stateFile, (s) => {
    const found = s.leases.find((x) => x.serial === serial);
    if (!found) return undefined;
    // A booting lease's emulator pid is not recorded yet; its getter owns the cleanup.
    if (found.state === 'booting') throw new Error(`device ${serial} is still booting`);
    if (opts.requireOwnerPid !== undefined && !mayRelease(runner, found.owner, opts.requireOwnerPid, Date.now())) {
      throw new Error(`device ${serial} belongs to another session`);
    }
    return { ...found };
  });
  if (!l) return { released: false, message: `no device ${serial}` };
  await teardown(runner, cfg, l);
  await dropLeases(cfg, [l.deviceId]);
  return { released: true, message: `released ${serial} (${l.deviceId})` };
}

/** True when `pid` owns the lease, or its owner is gone (dead mcp process or expired cli lease). */
function mayRelease(runner: Runner, o: Owner, pid: number, now: number): boolean {
  if (o.kind === 'cli') return o.expiresAt <= now;
  return o.pid === pid || !runner.isAlive(o.pid);
}

export async function renewLease(cfg: Config, serial: string): Promise<DeviceInfo> {
  return withState(cfg.stateFile, (s) => {
    const l = s.leases.find((x) => x.serial === serial);
    if (!l) throw new Error(`no device ${serial}`);
    if (l.owner.kind === 'cli') l.owner = { kind: 'cli', expiresAt: Date.now() + cfg.cliTtlMs };
    return toInfo(l);
  });
}

export function listDevices(cfg: Config): DeviceInfo[] {
  return readState(cfg.stateFile).leases.map(toInfo);
}

/** Decides (and records goneSince) under the lock; returns true when the lease should be removed. */
function shouldReap(runner: Runner, cfg: Config, l: Lease, now: number): boolean {
  if (l.state === 'booting') return now - l.createdAt >= cfg.bootTimeoutMs + BOOTING_GRACE_MS;
  const o = l.owner;
  if (o.kind === 'cli') {
    if (o.expiresAt <= now) return true;
  } else if (runner.isAlive(o.pid)) {
    delete o.goneSince;
  } else if (o.goneSince === undefined) {
    o.goneSince = now;
  } else if (now - o.goneSince > cfg.ownerGraceMs) {
    return true;
  }
  return !pidAlive(runner, l.emulatorPid);
}

export async function reap(runner: Runner, cfg: Config, now: number = Date.now()): Promise<string[]> {
  ensureDirs(cfg);
  const { victims, strays } = await withState(cfg.stateFile, (s) => {
    const victims = s.leases.filter((l) => shouldReap(runner, cfg, l, now)).map((l) => ({ ...l }));
    // Getters reserve a lease before cloning, so a dev-* file with no lease under the lock is stray.
    const leased = new Set(s.leases.map((l) => l.deviceId));
    const strays = new Set<string>();
    for (const name of fs.readdirSync(cfg.avdHome)) {
      const m = DEVICE_FILE_RE.exec(name);
      if (m && !leased.has(m[1]!)) strays.add(m[1]!);
    }
    return { victims, strays: [...strays] };
  });
  // One bad device must not block the rest; a victim whose teardown fails keeps its lease for the next reap.
  const torn: string[] = [];
  for (const l of victims) {
    try {
      await teardown(runner, cfg, l);
      torn.push(l.deviceId);
    } catch (e) {
      logReapFailure(l.deviceId, e);
    }
  }
  const swept: string[] = [];
  for (const id of strays) {
    try {
      removeDeviceFiles(cfg, id);
      swept.push(id);
    } catch (e) {
      logReapFailure(id, e);
    }
  }
  await dropLeases(cfg, torn);
  return [...torn, ...swept];
}

function logReapFailure(id: string, e: unknown): void {
  process.stderr.write(`droidpool: reap: ${id}: ${e instanceof Error ? e.message : String(e)}\n`);
}
