import fs from 'node:fs';
import path from 'node:path';
import { procAlive, type Runner } from './exec.ts';
import type { Config } from './config.ts';

export function envFor(cfg: Config): NodeJS.ProcessEnv {
  return { ...process.env, ANDROID_AVD_HOME: cfg.avdHome, ANDROID_SDK_ROOT: cfg.sdkRoot };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function emulatorVersion(runner: Runner, cfg: Config): Promise<string> {
  const r = await runner.run(cfg.emulatorBin, ['-version'], { env: envFor(cfg), timeoutMs: 30_000 });
  const m = /Android emulator version (\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
  if (!m) throw new Error(`could not parse emulator version from: ${r.stdout.slice(0, 200)}`);
  return m[1]!;
}

export function launchDevice(
  runner: Runner,
  cfg: Config,
  avdName: string,
  port: number,
  opts: { window?: boolean; snapshotSave?: boolean } = {},
): number {
  const args = ['-avd', avdName, '-port', String(port)];
  if (!opts.snapshotSave) args.push('-no-snapshot-save');
  args.push('-no-boot-anim');
  if (!opts.window) args.push('-no-window');
  return runner.spawnDetached(cfg.emulatorBin, args, {
    env: envFor(cfg),
    logFile: path.join(cfg.logsDir, `${avdName}.log`),
  });
}

function firstFatal(logFile: string): string {
  try {
    const line = fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.includes('FATAL'));
    return line?.trim() || 'no FATAL line';
  } catch {
    return 'no FATAL line';
  }
}

export async function waitBoot(
  runner: Runner,
  cfg: Config,
  serial: string,
  pid: number,
  logFile: string,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + cfg.bootTimeoutMs;
  for (;;) {
    if (!runner.isAlive(pid)) throw new Error(`emulator exited: ${firstFatal(logFile)}`);
    const r = await runner.run(cfg.adbBin, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      env: envFor(cfg),
      timeoutMs: 10_000,
    });
    if (r.code === 0 && r.stdout.trim() === '1') return;
    if (Date.now() >= deadline) {
      throw new Error(`boot timed out after ${Math.round(cfg.bootTimeoutMs / 1000)}s`);
    }
    await sleep(pollMs);
  }
}

/**
 * Asks the emulator to exit, then SIGKILLs its process group if it is still running after
 * killWaitMs. With a recorded start time, a reused pid is never signalled.
 */
export async function killDevice(
  runner: Runner,
  cfg: Config,
  serial: string,
  pid: number,
  start?: string,
): Promise<void> {
  // Non-zero exit is expected when the emulator is already dead.
  await runner.run(cfg.adbBin, ['-s', serial, 'emu', 'kill'], { env: envFor(cfg), timeoutMs: 10_000 });
  const step = Math.min(100, Math.max(1, cfg.killWaitMs / 10));
  const deadline = Date.now() + cfg.killWaitMs;
  while (procAlive(runner, pid, start) && Date.now() < deadline) await sleep(step);
  if (!procAlive(runner, pid, start)) return;
  // The emulator leads its own group (spawned detached), so helpers it started die with it.
  runner.kill(pid, 'SIGKILL', { group: true });
  const gone = Date.now() + 2000;
  while (procAlive(runner, pid, start) && Date.now() < gone) await sleep(step);
}

/** Console ports of every emulator adb knows about, droidpool's or not. */
export async function adbEmulatorPorts(runner: Runner, cfg: Config): Promise<Set<number>> {
  const r = await runner.run(cfg.adbBin, ['devices'], { env: envFor(cfg), timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`adb devices failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return new Set(
    r.stdout.split('\n').flatMap((line) => {
      const m = /^emulator-(\d+)\s/.exec(line);
      return m ? [Number(m[1])] : [];
    }),
  );
}

/** The emulator keeps a per-port modem file in its home (~/.android); remove it on teardown. */
export function removeModemFile(cfg: Config, port: number): void {
  fs.rmSync(path.join(cfg.emulatorHome, `modem-nv-ram-${port}`), { force: true });
}

export async function setAnimationsOff(runner: Runner, cfg: Config, serial: string): Promise<void> {
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    const r = await runner.run(
      cfg.adbBin,
      ['-s', serial, 'shell', 'settings', 'put', 'global', key, '0'],
      { env: envFor(cfg), timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(`failed to set ${key}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export async function saveSnapshot(runner: Runner, cfg: Config, serial: string): Promise<void> {
  const r = await runner.run(
    cfg.adbBin,
    ['-s', serial, 'emu', 'avd', 'snapshot', 'save', 'default_boot'],
    { env: envFor(cfg), timeoutMs: 120_000 },
  );
  if (r.code !== 0 || !r.stdout.includes('OK')) {
    throw new Error(`snapshot save failed (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
  }
}
