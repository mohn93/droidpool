import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './exec.ts';
import { ensureDirs, type Config } from './config.ts';
import { applyConfig, TUNED_CONFIG } from './avdfiles.ts';
import { readState, withState, type BaseRecord, type Flavor } from './state.ts';
import { assertDiskOk } from './disk.ts';
import { pickPort } from './ports.ts';
import {
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

export async function buildBase(
  runner: Runner,
  cfg: Config,
  flavor: Flavor,
  api: number,
  io: BaseIo,
): Promise<BaseRecord> {
  assertApiSupported(cfg, api);
  ensureDirs(cfg);
  assertDiskOk(cfg);
  const name = baseName(flavor, api);
  const image = imageFor(flavor, api);
  const env = envFor(cfg);

  const used = await withState(
    cfg.stateFile,
    (s) => new Set(s.leases.map((l) => l.port)),
  );
  const port = pickPort(cfg, used);
  if (port === null) throw new Error('no free emulator port for base build');
  const serial = `emulator-${port}`;

  io.log(`installing system image ${image}`);
  const sdk = await runner.run(cfg.sdkmanagerBin, [image], { env, input: 'y\n', timeoutMs: 600_000 });
  if (sdk.code !== 0) throw new Error(`sdkmanager failed: ${(sdk.stderr || sdk.stdout).trim().slice(0, 300)}`);

  let pid: number | undefined;
  try {
    io.log(`creating AVD ${name}`);
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

    io.log(`booting ${name} on ${serial}`);
    pid = launchDevice(runner, cfg, name, port, { snapshotSave: true, window: flavor === 'signed-in' });
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
    });
    return record;
  } catch (e) {
    if (pid !== undefined) {
      try {
        await killDevice(runner, cfg, serial, pid);
      } catch {
        // best effort; the original error matters more
      }
    }
    removeAvdFiles(cfg, name);
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
    const n = s.leases.filter((l) => l.flavor === base.flavor && l.api === base.api).length;
    if (n > 0) throw new Error(`base ${name} has ${n} active devices`);
    s.bases = s.bases.filter((b) => b.name !== name);
  });
  removeAvdFiles(cfg, name);
}

export async function assertBaseUsable(
  runner: Runner,
  cfg: Config,
  flavor: Flavor,
  api: number,
): Promise<BaseRecord> {
  assertApiSupported(cfg, api);
  const name = baseName(flavor, api);
  const base = readState(cfg.stateFile).bases.find((b) => b.name === name);
  if (!base) throw new Error(`no base for ${flavor} API ${api}. Build one: droidpool base build ${flavor} --api ${api}`);
  const current = await emulatorVersion(runner, cfg);
  if (current !== base.emulatorVersion) {
    throw new Error(
      `base ${name} was built on emulator ${base.emulatorVersion}; emulator is now ${current}. Rebuild: droidpool base build ${flavor} --api ${api}`,
    );
  }
  return base;
}
