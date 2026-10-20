import fs from 'node:fs';
import path from 'node:path';
import { localProcAlive, realRunner, type Runner } from './exec.ts';
import { ensureDirs, type Config } from './config.ts';
import { applyConfig, TUNED_CONFIG } from './avdfiles.ts';
import { readState, withState, type BaseRecord, type Flavor, type State } from './state.ts';
import { assertDiskOk } from './disk.ts';
import {
  adbEmulatorPorts,
  emulatorVersion,
  envFor,
  killDevice,
  launchDevice,
  saveSnapshot,
  setAnimationsOff,
  waitBoot,
} from './emulator.ts';

export interface BaseIo {
  waitForUser(prompt: string): Promise<void>;
  log(msg: string): void;
}

export function baseName(flavor: Flavor, api: number): string {
  return `base-${flavor}-${api}`;
}

export function imageFor(flavor: Flavor, api: number): string {
  const tag = flavor === 'clean' ? 'google_apis' : 'google_apis_playstore';
  return `system-images;android-${api};${tag};arm64-v8a`;
}

function assertApiSupported(cfg: Config, api: number): void {
  if (!cfg.supportedApis.includes(api)) {
    throw new Error(`API ${api} not supported in v1 (supported: ${cfg.supportedApis.join(', ')})`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function removeAvdFiles(cfg: Config, name: string): void {
  fs.rmSync(path.join(cfg.avdHome, `${name}.avd`), { recursive: true, force: true });
  fs.rmSync(path.join(cfg.avdHome, `${name}.ini`), { force: true });
}

/**
 * The build this process is running, so a signal handler can stop it. avdCreated is set once
 * avdmanager --force may have replaced the previous base's files.
 */
let liveBuild: { name: string; pid?: number; avdCreated: boolean } | undefined;

export function buildInProgress(): boolean {
  return liveBuild !== undefined;
}

/**
 * Synchronous best effort for signal handlers: SIGKILL the live base emulator and remove the
 * partial base AVD files. A no-op when no build is running. The base record is left; getters
 * refuse a base whose snapshot files are missing.
 */
export function abortCurrentBuild(runner: Runner, cfg: Config): void {
  const b = liveBuild;
  if (!b) return;
  liveBuild = undefined;
  if (b.pid !== undefined) runner.kill(b.pid, 'SIGKILL', { group: true });
  if (!b.avdCreated) return;
  try {
    removeAvdFiles(cfg, b.name);
  } catch {
    // best effort; the process is exiting
  }
}

function liveBuildOf(s: State, name: string) {
  return s.builds.find((b) => b.name === name && localProcAlive(b));
}

/** Throws while a live process is rebuilding the base, whose files are then half-written. */
export function assertNotBuilding(s: State, name: string): void {
  const b = liveBuildOf(s, name);
  if (b) throw new Error(`base ${name} is being rebuilt (pid ${b.pid}); retry when the build finishes`);
}

const activeDevices = (s: State, flavor: Flavor, api: number) =>
  s.leases.filter((l) => l.flavor === flavor && l.api === api).length;

/** Number of even ports above the pool range that base builds may use. */
const BASE_PORT_SPAN = 20;

/**
 * Base builds run outside the pool's port range so they never collide with a lease that a
 * concurrent getter reserves. The first even port in [portMax+2, portMax+20] that adb does
 * not already list is used.
 */
async function pickBasePort(runner: Runner, cfg: Config): Promise<number> {
  const listed = await adbEmulatorPorts(runner, cfg);
  const first = cfg.portMax + 2 + (cfg.portMax % 2);
  for (let p = first; p <= cfg.portMax + BASE_PORT_SPAN; p += 2) {
    if (!listed.has(p)) return p;
  }
  throw new Error('no free port for base build');
}

export async function buildBase(
  runner: Runner,
  cfg: Config,
  flavor: Flavor,
  api: number,
  io: BaseIo,
): Promise<BaseRecord> {
  assertApiSupported(cfg, api);
  ensureDirs(cfg);
  const name = baseName(flavor, api);
  const image = imageFor(flavor, api);
  const env = envFor(cfg);

  // Claim the build under the lock: getters refuse this base until it finishes, and the
  // files are only replaced when no device is cloned from them.
  await withState(cfg.stateFile, (s) => {
    const other = liveBuildOf(s, name);
    if (other) throw new Error(`base ${name} is already being built (pid ${other.pid})`);
    const n = activeDevices(s, flavor, api);
    if (n > 0) throw new Error(`base ${name} has ${n} active devices; release them before rebuilding`);
    assertDiskOk(cfg, cfg.freeBytesFn(cfg.home), s.leases.length);
    s.builds = s.builds.filter((b) => b.name !== name);
    s.builds.push({ name, pid: process.pid, start: realRunner.startTime(process.pid), startedAt: Date.now() });
  });
  liveBuild = { name, avdCreated: false };

  let pid: number | undefined;
  let serial = '';
  try {
    io.log(`installing system image ${image}`);
    const sdk = await runner.run(cfg.sdkmanagerBin, [image], { env, input: 'y\n', timeoutMs: 600_000 });
    if (sdk.code !== 0) throw new Error(`sdkmanager failed: ${(sdk.stderr || sdk.stdout).trim().slice(0, 300)}`);

    io.log(`creating AVD ${name}`);
    liveBuild.avdCreated = true;
    const create = await runner.run(
      cfg.avdmanagerBin,
      ['create', 'avd', '-n', name, '-k', image, '-d', 'pixel_7', '--force'],
      { env, input: 'no\n', timeoutMs: 120_000 },
    );
    if (create.code !== 0) {
      throw new Error(`avdmanager create failed: ${(create.stderr || create.stdout).trim().slice(0, 300)}`);
    }
    const configPath = path.join(cfg.avdHome, `${name}.avd`, 'config.ini');
    fs.writeFileSync(configPath, applyConfig(fs.readFileSync(configPath, 'utf8'), TUNED_CONFIG));

    const port = await pickBasePort(runner, cfg);
    serial = `emulator-${port}`;
    io.log(`booting ${name} on ${serial}`);
    // Same snapshot flags as devices: the explicit save below is the only write. Letting the
    // emulator also save on exit races killDevice and can truncate ram.bin.
    // One log per build, so a FATAL line from an earlier build is never reported.
    fs.writeFileSync(path.join(cfg.logsDir, `${name}.log`), '');
    pid = launchDevice(runner, cfg, name, port, { window: flavor === 'signed-in' });
    liveBuild.pid = pid;
    await waitBoot(runner, cfg, serial, pid, path.join(cfg.logsDir, `${name}.log`), cfg.bootPollMs);
    io.log(`settling for ${Math.round(cfg.baseSettleMs / 1000)}s`);
    await sleep(cfg.baseSettleMs);
    await setAnimationsOff(runner, cfg, serial);
    if (flavor === 'signed-in') {
      await io.waitForUser(
        'Sign in to Google and Play in the emulator window, finish any setup prompts, then continue.',
      );
    }
    io.log('saving snapshot');
    await saveSnapshot(runner, cfg, serial);
    await killDevice(runner, cfg, serial, pid);
    pid = undefined;

    const record: BaseRecord = {
      name,
      flavor,
      api,
      image,
      emulatorVersion: await emulatorVersion(runner, cfg),
      ramMb: Number(TUNED_CONFIG['hw.ramSize']),
      builtAt: new Date().toISOString(),
    };
    await withState(cfg.stateFile, (s) => {
      s.bases = s.bases.filter((b) => b.name !== name);
      s.bases.push(record);
      s.builds = s.builds.filter((b) => b.name !== name);
    });
    liveBuild = undefined;
    return record;
  } catch (e) {
    if (pid !== undefined) {
      try {
        await killDevice(runner, cfg, serial, pid);
      } catch {
        // best effort; the original error matters more
      }
    }
    // Before avdmanager ran, the previous base is intact and stays usable.
    const replaced = liveBuild?.avdCreated ?? true;
    liveBuild = undefined;
    if (replaced) removeAvdFiles(cfg, name);
    try {
      await withState(cfg.stateFile, (s) => {
        // --force overwrote any previous AVD, so its record no longer describes real files.
        if (replaced) s.bases = s.bases.filter((b) => b.name !== name);
        s.builds = s.builds.filter((b) => b.name !== name);
      });
    } catch {
      // best effort; the original build error matters more
    }
    throw e;
  }
}

export function listBases(cfg: Config): BaseRecord[] {
  return readState(cfg.stateFile).bases;
}

export async function removeBase(runner: Runner, cfg: Config, name: string): Promise<void> {
  void runner;
  await withState(cfg.stateFile, (s) => {
    const base = s.bases.find((b) => b.name === name);
    if (!base) throw new Error(`no such base: ${name}`);
    if (liveBuildOf(s, name)) throw new Error(`base ${name} is being built`);
    const n = activeDevices(s, base.flavor, base.api);
    if (n > 0) throw new Error(`base ${name} has ${n} active devices`);
    s.bases = s.bases.filter((b) => b.name !== name);
    // Under the lock, so a build that starts right after cannot lose its new files to this delete.
    removeAvdFiles(cfg, name);
  });
}

export async function assertBaseUsable(
  runner: Runner,
  cfg: Config,
  flavor: Flavor,
  api: number,
): Promise<BaseRecord> {
  assertApiSupported(cfg, api);
  const name = baseName(flavor, api);
  const s = readState(cfg.stateFile);
  const base = s.bases.find((b) => b.name === name);
  if (!base) throw new Error(`no base for ${flavor} API ${api}. Build one: droidpool base build ${flavor} --api ${api}`);
  assertNotBuilding(s, name);
  if (!fs.existsSync(path.join(cfg.avdHome, `${name}.avd`, 'snapshots', 'default_boot', 'hardware.ini'))) {
    throw new Error(`base ${name} has no snapshot on disk. Rebuild: droidpool base build ${flavor} --api ${api}`);
  }
  const current = await emulatorVersion(runner, cfg);
  if (current !== base.emulatorVersion) {
    throw new Error(
      `base ${name} was built on emulator ${base.emulatorVersion}; emulator is now ${current}. Rebuild: droidpool base build ${flavor} --api ${api}`,
    );
  }
  return base;
}
