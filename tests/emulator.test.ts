import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import {
  emulatorVersion,
  launchDevice,
  waitBoot,
  killDevice,
  setAnimationsOff,
  saveSnapshot,
} from '../src/emulator.ts';
import { FakeRunner } from './fakes.ts';

const cfg = loadConfig({ HOME: '/h' });
const isGetprop = (_c: string, a: string[]) => a.includes('getprop');

test('emulatorVersion parses', async () => {
  const f = new FakeRunner();
  f.onRun(() => true, {
    code: 0,
    stdout: 'Android emulator version 36.5.11.0 (build_id 15261927) (CL:N/A)\n',
    stderr: '',
  });
  assert.equal(await emulatorVersion(f, cfg), '36.5.11');
  assert.equal(f.calls[0]!.cmd, cfg.emulatorBin);
  assert.deepEqual(f.calls[0]!.args, ['-version']);
});

test('emulatorVersion throws on unparseable output', async () => {
  const f = new FakeRunner();
  f.onRun(() => true, { code: 0, stdout: 'garbage', stderr: '' });
  await assert.rejects(emulatorVersion(f, cfg), /version/);
});

test('launchDevice uses exact flags and AVD home', () => {
  const f = new FakeRunner();
  f.onSpawn(4242);
  const pid = launchDevice(f, cfg, 'dev-abc123', 5620);
  assert.equal(pid, 4242);
  const c = f.calls[0]!;
  assert.equal(c.kind, 'spawn');
  assert.equal(c.cmd, cfg.emulatorBin);
  assert.deepEqual(c.args, ['-avd', 'dev-abc123', '-port', '5620', '-no-snapshot-save', '-no-boot-anim', '-no-window']);
  assert.equal(c.env!.ANDROID_AVD_HOME, cfg.avdHome);
  assert.equal(c.env!.ANDROID_SDK_ROOT, cfg.sdkRoot);
  assert.equal(c.logFile, path.join(cfg.logsDir, 'dev-abc123.log'));

  launchDevice(f, cfg, 'dev-abc123', 5620, { window: true, snapshotSave: true });
  assert.deepEqual(f.calls[1]!.args, ['-avd', 'dev-abc123', '-port', '5620', '-no-boot-anim']);
});

test('waitBoot succeeds when boot_completed is 1', async () => {
  const f = new FakeRunner();
  f.alive.add(1);
  const outs = ['', '', '1\n'];
  f.onRun(isGetprop, () => ({ code: 0, stdout: outs.shift() ?? '1\n', stderr: '' }));
  await waitBoot(f, cfg, 'emulator-5620', 1, '/nonexistent.log', 5);
  const gp = f.calls.filter((c) => c.args.includes('getprop'));
  assert.equal(gp.length, 3);
  assert.deepEqual(gp[0]!.args, ['-s', 'emulator-5620', 'shell', 'getprop', 'sys.boot_completed']);
  assert.equal(gp[0]!.cmd, cfg.adbBin);
  assert.equal(gp[0]!.env!.ANDROID_AVD_HOME, cfg.avdHome);
});

test('waitBoot reports FATAL on exit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const log = path.join(tmp, 'e.log');
  fs.writeFileSync(log, 'INFO | starting\nFATAL | Not enough space to create userdata partition\n');
  const f = new FakeRunner();
  await assert.rejects(
    waitBoot(f, cfg, 'emulator-5620', 7, log, 5),
    /emulator exited: .*Not enough space/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('waitBoot reports no FATAL line when log is missing', async () => {
  const f = new FakeRunner();
  await assert.rejects(
    waitBoot(f, cfg, 'emulator-5620', 7, '/nonexistent.log', 5),
    /emulator exited: no FATAL line/,
  );
});

test('waitBoot times out', async () => {
  const f = new FakeRunner();
  f.alive.add(1);
  f.onRun(isGetprop, { code: 0, stdout: '', stderr: '' });
  await assert.rejects(
    waitBoot(f, { ...cfg, bootTimeoutMs: 50 }, 'emulator-5620', 1, '/nonexistent.log', 5),
    /boot timed out after \d+s/,
  );
});

test('killDevice sends emu kill and returns when pid dies', async () => {
  const f = new FakeRunner();
  f.alive.add(9);
  f.onRun(
    (_c, a) => a.includes('kill'),
    () => {
      f.alive.delete(9);
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  await killDevice(f, { ...cfg, killWaitMs: 50 }, 'emulator-5620', 9);
  assert.deepEqual(f.calls[0]!.args, ['-s', 'emulator-5620', 'emu', 'kill']);
  assert.equal(f.killed.length, 0);
});

test('killDevice tolerates non-zero emu kill on dead emulator', async () => {
  const f = new FakeRunner();
  f.onRun((_c, a) => a.includes('kill'), { code: 1, stdout: '', stderr: 'error: device offline' });
  await killDevice(f, { ...cfg, killWaitMs: 50 }, 'emulator-5620', 9);
  assert.equal(f.killed.length, 0);
});

test('killDevice escalates', async () => {
  const f = new FakeRunner();
  f.alive.add(9);
  await killDevice(f, { ...cfg, killWaitMs: 50 }, 'emulator-5620', 9);
  assert.deepEqual(f.killed, [{ pid: 9, signal: 'SIGKILL' }]);
});

test('setAnimationsOff sets three global scales to 0', async () => {
  const f = new FakeRunner();
  await setAnimationsOff(f, cfg, 'emulator-5620');
  const keys = f.calls.map((c) => c.args.join(' '));
  for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    assert.ok(keys.includes(`-s emulator-5620 shell settings put global ${k} 0`), k);
  }
});

test('saveSnapshot succeeds on OK', async () => {
  const f = new FakeRunner();
  f.onRun(() => true, { code: 0, stdout: 'OK\n', stderr: '' });
  await saveSnapshot(f, cfg, 'emulator-5620');
  assert.deepEqual(f.calls[0]!.args, ['-s', 'emulator-5620', 'emu', 'avd', 'snapshot', 'save', 'default_boot']);
});

test('saveSnapshot throws on non-zero or missing OK', async () => {
  const f = new FakeRunner();
  f.onRun(() => true, { code: 1, stdout: 'OK', stderr: 'boom' });
  await assert.rejects(saveSnapshot(f, cfg, 'emulator-5620'), /snapshot/);
  const g = new FakeRunner();
  g.onRun(() => true, { code: 0, stdout: 'KO: failed\n', stderr: '' });
  await assert.rejects(saveSnapshot(g, cfg, 'emulator-5620'), /snapshot/);
});
