import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { captureStderr, FakeRunner } from './fakes.ts';
import { readState, withState, type BaseRecord, type Lease } from '../src/state.ts';
import { deviceIni } from '../src/avdfiles.ts';
import {
  getDevice,
  listDevices,
  poolFullMessage,
  POOL_FULL_MESSAGE,
  reap,
  releaseDevice,
  renewLease,
} from '../src/pool.ts';

const VERSION = '36.5.11';
const DEAD_PID = 999_999;

function setup(over: Partial<Config> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pool-'));
  const cfg: Config = {
    ...loadConfig({ HOME: tmp }),
    bootPollMs: 2,
    killWaitMs: 20,
    queuePollMs: 10,
    freeBytesFn: () => 100 * 2 ** 30,
    cloneProbe: { dev: () => 1, fsType: () => 26 },
    ...over,
  };
  fs.mkdirSync(cfg.avdHome, { recursive: true });
  const baseDir = path.join(cfg.avdHome, 'base-clean-35.avd');
  fs.mkdirSync(path.join(baseDir, 'snapshots', 'default_boot'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.ini'), 'hw.ramSize=4096\n');
  fs.writeFileSync(path.join(baseDir, 'multiinstance.lock'), '');
  fs.writeFileSync(path.join(baseDir, 'hardware-qemu.ini'), `x = ${baseDir}/x\n`);
  fs.writeFileSync(
    path.join(baseDir, 'snapshots', 'default_boot', 'hardware.ini'),
    [
      'avd.name = base-clean-35',
      'avd.id = base-clean-35',
      `disk.dataPartition.path = ${baseDir}/userdata-qemu.img`,
      `disk.cachePartition.path = ${baseDir}/cache.img`,
      'hw.ramSize = 4096',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(cfg.avdHome, 'base-clean-35.ini'), `path=${baseDir}\n`);
  const rec: BaseRecord = {
    name: 'base-clean-35',
    flavor: 'clean',
    api: 35,
    image: 'system-images;android-35;google_apis;arm64-v8a',
    emulatorVersion: VERSION,
    ramMb: 4096,
    builtAt: 'x',
  };
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [rec], leases: [] }));
  return { tmp, cfg, baseDir };
}

function fakeRunner(cfg: Config): FakeRunner {
  const r = new FakeRunner();
  r.onRun((c, a) => c === cfg.emulatorBin && a[0] === '-version', {
    code: 0,
    stdout: `Android emulator version ${VERSION} (build_id 1)\n`,
    stderr: '',
  });
  r.onRun(
    (c) => c === 'cp',
    (_c, a) => {
      fs.cpSync(a[2]!, a[3]!, { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  r.onRun((c, a) => c === cfg.adbBin && a.includes('getprop'), { code: 0, stdout: '1\n', stderr: '' });
  return r;
}

const cli = () => ({ kind: 'cli' as const, expiresAt: Date.now() + 3_600_000 });
const cpCalls = (r: FakeRunner) => r.calls.filter((c) => c.cmd === 'cp').length;
const devDir = (cfg: Config, id: string) => path.join(cfg.avdHome, `${id}.avd`);

function lease(over: Partial<Lease>): Lease {
  return {
    deviceId: 'dev-aaaaaa',
    serial: 'emulator-5620',
    port: 5620,
    emulatorPid: 7001,
    flavor: 'clean',
    api: 35,
    project: '/p',
    owner: cli(),
    createdAt: Date.now(),
    state: 'ready',
    ...over,
  };
}

async function seed(cfg: Config, ...leases: Lease[]): Promise<void> {
  await withState(cfg.stateFile, (s) => {
    s.leases.push(...leases);
  });
  for (const l of leases) {
    fs.mkdirSync(devDir(cfg, l.deviceId), { recursive: true });
    fs.writeFileSync(path.join(cfg.avdHome, `${l.deviceId}.ini`), deviceIni(devDir(cfg, l.deviceId), 35));
  }
}

test('POOL_FULL_MESSAGE text', () => {
  assert.equal(
    POOL_FULL_MESSAGE,
    'device pool is full (max <n>). Do not start an emulator yourself; retry later or ask the user to release a device.',
  );
  assert.equal(
    poolFullMessage(1),
    'device pool is full (max 1). Do not start an emulator yourself; retry later or ask the user to release a device.',
  );
});

test('get clones, launches, returns serial', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  const info = await getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() });
  assert.equal(info.serial, 'emulator-5620');
  assert.match(info.deviceId, /^dev-[0-9a-f]{6}$/);
  assert.equal(info.state, 'ready');
  assert.equal(info.flavor, 'clean');
  assert.equal(info.api, 35);
  assert.equal(info.project, '/p');

  const dir = devDir(cfg, info.deviceId);
  const hw = fs.readFileSync(path.join(dir, 'snapshots', 'default_boot', 'hardware.ini'), 'utf8');
  assert.ok(!hw.includes('base-clean-35'), hw);
  assert.ok(hw.includes(`avd.name = ${info.deviceId}`));
  assert.ok(hw.includes(`disk.dataPartition.path = ${dir}/userdata-qemu.img`));
  assert.equal(fs.readFileSync(path.join(cfg.avdHome, `${info.deviceId}.ini`), 'utf8'), deviceIni(dir, 35));
  assert.ok(!fs.existsSync(path.join(dir, 'multiinstance.lock')));
  assert.ok(!fs.existsSync(path.join(dir, 'hardware-qemu.ini')));
  // base untouched
  assert.ok(fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd', 'multiinstance.lock')));

  const spawn = r.calls.find((c) => c.kind === 'spawn')!;
  assert.deepEqual(spawn.args, [
    '-avd', info.deviceId, '-port', '5620', '-no-snapshot-save', '-no-boot-anim', '-no-window',
  ]);
  assert.equal(spawn.logFile, path.join(cfg.logsDir, `${info.deviceId}.log`));

  const leases = readState(cfg.stateFile).leases;
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.state, 'ready');
  assert.equal(leases[0]!.emulatorPid, 5001);
  assert.deepEqual(listDevices(cfg), [info]);
});

test('get checks disk before cloning', async () => {
  const { cfg } = setup({ freeBytesFn: () => 1 * 2 ** 30 });
  const r = fakeRunner(cfg).onSpawn(5001);
  await assert.rejects(getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() }), /not enough disk/);
  assert.equal(cpCalls(r), 0);
  assert.equal(readState(cfg.stateFile).leases.length, 0);
});

test('get without a base names the build command', async () => {
  const { cfg } = setup();
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [], leases: [] }));
  const r = fakeRunner(cfg).onSpawn(5001);
  await assert.rejects(
    getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() }),
    /droidpool base build clean --api 35/,
  );
  assert.equal(cpCalls(r), 0);
});

test('boot failure cleans up', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  r.onRun(
    (c, a) => c === cfg.adbBin && a.includes('getprop'),
    () => {
      const log = r.calls.find((c) => c.kind === 'spawn')!.logFile!;
      fs.appendFileSync(log, 'INFO starting\nFATAL | cannot open snapshot\n');
      r.alive.delete(5001);
      return { code: 1, stdout: '', stderr: 'device offline' };
    },
  );
  await assert.rejects(
    getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() }),
    /emulator exited: FATAL \| cannot open snapshot/,
  );
  const id = r.calls.find((c) => c.kind === 'spawn')!.args[1]!;
  assert.ok(!fs.existsSync(devDir(cfg, id)));
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, `${id}.ini`)));
  assert.equal(readState(cfg.stateFile).leases.length, 0);
});

test('boot timeout kills and cleans up', async () => {
  const { cfg } = setup({ bootTimeoutMs: 50 });
  const r = fakeRunner(cfg).onSpawn(5001);
  r.onRun((c, a) => c === cfg.adbBin && a.includes('getprop'), { code: 0, stdout: '0\n', stderr: '' });
  await assert.rejects(getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() }), /boot timed out/);
  assert.ok(r.calls.some((c) => c.cmd === cfg.adbBin && c.args.join(' ') === '-s emulator-5620 emu kill'));
  assert.ok(!r.isAlive(5001));
  const id = r.calls.find((c) => c.kind === 'spawn')!.args[1]!;
  assert.ok(!fs.existsSync(devDir(cfg, id)));
  assert.equal(readState(cfg.stateFile).leases.length, 0);
});

test('pool full waits then fails', async () => {
  const { cfg } = setup({ maxDevices: 1, queueWaitMs: 100 });
  const r = fakeRunner(cfg).onSpawn(5001, 5002);
  await getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() });
  const t0 = Date.now();
  await assert.rejects(getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() }), {
    message: poolFullMessage(1),
  });
  assert.ok(Date.now() - t0 >= 100);
  assert.equal(cpCalls(r), 1);
  assert.equal(readState(cfg.stateFile).leases.length, 1);
});

test('pool full succeeds when a slot frees', async () => {
  const { cfg } = setup({ maxDevices: 1, queueWaitMs: 2000 });
  const r = fakeRunner(cfg).onSpawn(5001, 5002);
  const first = await getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() });
  const t0 = Date.now();
  const timer = setTimeout(() => void releaseDevice(r, cfg, first.serial), 200);
  try {
    const second = await getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() });
    assert.ok(Date.now() - t0 >= 200);
    assert.notEqual(second.deviceId, first.deviceId);
    assert.deepEqual(listDevices(cfg).map((d) => d.deviceId), [second.deviceId]);
  } finally {
    clearTimeout(timer);
  }
});

test('parallel gets get distinct ports', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001, 5002, 5003);
  const infos = await Promise.all(
    [1, 2, 3].map(() => getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() })),
  );
  assert.deepEqual(infos.map((i) => i.serial).sort(), ['emulator-5620', 'emulator-5622', 'emulator-5624']);
  assert.equal(new Set(infos.map((i) => i.deviceId)).size, 3);
  const leases = readState(cfg.stateFile).leases;
  assert.equal(leases.length, 3);
  assert.deepEqual(leases.map((l) => l.emulatorPid).sort(), [5001, 5002, 5003]);
  assert.ok(leases.every((l) => l.state === 'ready'));
});

test('release is idempotent', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  const info = await getDevice(r, cfg, { flavor: 'clean', project: '/p', owner: cli() });
  const res = await releaseDevice(r, cfg, 'emulator-5620');
  assert.equal(res.released, true);
  assert.ok(r.calls.some((c) => c.args.join(' ') === '-s emulator-5620 emu kill'));
  assert.ok(!r.isAlive(5001));
  assert.ok(!fs.existsSync(devDir(cfg, info.deviceId)));
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, `${info.deviceId}.ini`)));
  assert.equal(readState(cfg.stateFile).leases.length, 0);
  assert.deepEqual(await releaseDevice(r, cfg, 'emulator-5620'), {
    released: false,
    message: 'no device emulator-5620',
  });
});

test('reap removes dead mcp owners after grace', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001);
  await seed(cfg, lease({ owner: { kind: 'mcp', pid: DEAD_PID } }));
  const now = Date.now();
  assert.deepEqual(await reap(r, cfg, now), []);
  const l = readState(cfg.stateFile).leases[0]!;
  assert.deepEqual(l.owner, { kind: 'mcp', pid: DEAD_PID, goneSince: now });
  assert.deepEqual(await reap(r, cfg, now + 120_000), []);
  assert.deepEqual(await reap(r, cfg, now + 120_001), ['dev-aaaaaa']);
  assert.equal(readState(cfg.stateFile).leases.length, 0);
  assert.ok(!fs.existsSync(devDir(cfg, 'dev-aaaaaa')));
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'dev-aaaaaa.ini')));
  assert.ok(!r.isAlive(7001));
});

test('reap clears goneSince when an mcp owner is seen alive again', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001);
  await seed(cfg, lease({ owner: { kind: 'mcp', pid: 7777, goneSince: Date.now() - 1000 } }));
  r.alive.add(7777);
  assert.deepEqual(await reap(r, cfg), []);
  assert.deepEqual(readState(cfg.stateFile).leases[0]!.owner, { kind: 'mcp', pid: 7777 });
});

test('reap keeps live mcp owners and unexpired cli leases', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001).add(7002).add(7777);
  await seed(
    cfg,
    lease({ owner: { kind: 'mcp', pid: 7777 } }),
    lease({ deviceId: 'dev-bbbbbb', serial: 'emulator-5622', port: 5622, emulatorPid: 7002 }),
  );
  assert.deepEqual(await reap(r, cfg, Date.now() + 1_000_000), []);
  assert.equal(readState(cfg.stateFile).leases.length, 2);
  assert.ok(fs.existsSync(devDir(cfg, 'dev-aaaaaa')));
  assert.ok(fs.existsSync(devDir(cfg, 'dev-bbbbbb')));
});

test('reap removes expired cli leases, dead emulators, and unleased dirs', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001).add(7003);
  const now = Date.now();
  await seed(
    cfg,
    lease({ owner: { kind: 'cli', expiresAt: now } }),
    lease({ deviceId: 'dev-bbbbbb', serial: 'emulator-5622', port: 5622, emulatorPid: DEAD_PID }),
    lease({ deviceId: 'dev-cccccc', serial: 'emulator-5624', port: 5624, emulatorPid: 7003 }),
  );
  fs.mkdirSync(devDir(cfg, 'dev-ffffff'));
  fs.writeFileSync(path.join(cfg.avdHome, 'dev-ffffff.ini'), 'x');
  fs.writeFileSync(path.join(cfg.avdHome, 'dev-eeeeee.ini'), 'x');
  const removed = await reap(r, cfg, now);
  assert.deepEqual(removed.sort(), ['dev-aaaaaa', 'dev-bbbbbb', 'dev-eeeeee', 'dev-ffffff']);
  assert.deepEqual(readState(cfg.stateFile).leases.map((l) => l.deviceId), ['dev-cccccc']);
  for (const id of ['dev-aaaaaa', 'dev-bbbbbb', 'dev-ffffff', 'dev-eeeeee']) {
    assert.ok(!fs.existsSync(devDir(cfg, id)), id);
    assert.ok(!fs.existsSync(path.join(cfg.avdHome, `${id}.ini`)), id);
  }
  assert.ok(!r.isAlive(7001));
  assert.ok(r.isAlive(7003));
  assert.ok(fs.existsSync(devDir(cfg, 'dev-cccccc')));
  assert.ok(fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd')));
  assert.ok(fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.ini')));
  // the dead emulator is not killed again
  assert.ok(!r.calls.some((c) => c.args.join(' ') === '-s emulator-5622 emu kill'));
});

test('reap leaves young booting leases alone and reaps stale ones', async () => {
  const { cfg } = setup({ bootTimeoutMs: 1000 });
  const r = fakeRunner(cfg);
  r.alive.add(7002);
  const now = Date.now();
  await seed(
    cfg,
    lease({ state: 'booting', emulatorPid: 0, createdAt: now - 60_999, owner: { kind: 'mcp', pid: DEAD_PID } }),
    lease({
      deviceId: 'dev-bbbbbb',
      serial: 'emulator-5622',
      port: 5622,
      state: 'booting',
      emulatorPid: 7002,
      createdAt: now - 61_001,
    }),
  );
  assert.deepEqual(await reap(r, cfg, now), ['dev-bbbbbb']);
  const left = readState(cfg.stateFile).leases;
  assert.deepEqual(left.map((l) => l.deviceId), ['dev-aaaaaa']);
  assert.equal(left[0]!.owner.kind === 'mcp' && left[0]!.owner.goneSince, undefined);
  assert.ok(!r.isAlive(7002));
  assert.ok(fs.existsSync(devDir(cfg, 'dev-aaaaaa')));
  assert.ok(!fs.existsSync(devDir(cfg, 'dev-bbbbbb')));
});

test('reuseSerial adopts a gone owner within grace', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001);
  await seed(cfg, lease({ owner: { kind: 'mcp', pid: DEAD_PID, goneSince: Date.now() - 1000 } }));
  const info = await getDevice(r, cfg, {
    flavor: 'clean',
    project: '/q',
    owner: { kind: 'mcp', pid: process.pid },
    reuseSerial: 'emulator-5620',
  });
  assert.equal(info.serial, 'emulator-5620');
  assert.equal(info.deviceId, 'dev-aaaaaa');
  assert.equal(info.project, '/q');
  assert.deepEqual(info.owner, { kind: 'mcp', pid: process.pid });
  assert.equal(cpCalls(r), 0);
  assert.ok(!r.calls.some((c) => c.kind === 'spawn'));
  assert.deepEqual(readState(cfg.stateFile).leases[0]!.owner, { kind: 'mcp', pid: process.pid });
});

test('reuseSerial refuses a device whose owner is alive', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001).add(7777);
  await seed(cfg, lease({ owner: { kind: 'mcp', pid: 7777 } }));
  await assert.rejects(
    getDevice(r, cfg, {
      flavor: 'clean',
      project: '/p',
      owner: { kind: 'mcp', pid: process.pid },
      reuseSerial: 'emulator-5620',
    }),
    { message: 'device emulator-5620 is owned by another live session' },
  );
  assert.deepEqual(readState(cfg.stateFile).leases[0]!.owner, { kind: 'mcp', pid: 7777 });
});

test('reuseSerial with no such lease gets a fresh device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  const info = await getDevice(r, cfg, {
    flavor: 'clean',
    project: '/p',
    owner: { kind: 'mcp', pid: process.pid },
    reuseSerial: 'emulator-5630',
  });
  assert.equal(info.serial, 'emulator-5620');
  assert.equal(cpCalls(r), 1);
});

test('renewLease extends cli leases and leaves mcp leases unchanged', async () => {
  const { cfg } = setup({ cliTtlMs: 5000 });
  const r = fakeRunner(cfg);
  r.alive.add(7001).add(7002);
  await seed(
    cfg,
    lease({ owner: { kind: 'cli', expiresAt: 1 } }),
    lease({ deviceId: 'dev-bbbbbb', serial: 'emulator-5622', port: 5622, emulatorPid: 7002, owner: { kind: 'mcp', pid: 7777 } }),
  );
  const before = Date.now();
  const info = await renewLease(cfg, 'emulator-5620');
  assert.equal(info.owner.kind, 'cli');
  const exp = info.owner.kind === 'cli' ? info.owner.expiresAt : 0;
  assert.ok(exp >= before + 5000 && exp <= Date.now() + 5000);
  assert.deepEqual(readState(cfg.stateFile).leases[0]!.owner, { kind: 'cli', expiresAt: exp });
  assert.deepEqual((await renewLease(cfg, 'emulator-5622')).owner, { kind: 'mcp', pid: 7777 });
  await assert.rejects(renewLease(cfg, 'emulator-5699'), { message: 'no device emulator-5699' });
});

/**
 * Puts `x` into state after getDevice's entry reap has decided, simulating a lease that reap
 * would remove but has not yet. A decoy expired lease makes reap tear down; its `emu kill`
 * (run outside the lock) writes `x` in. The final lease drop only removes the decoy.
 */
async function injectAfterEntryReap(r: FakeRunner, cfg: Config, x: Lease): Promise<void> {
  const decoy = lease({
    deviceId: 'dev-dddddd',
    serial: 'emulator-5680',
    port: 5680,
    emulatorPid: 7100,
    owner: { kind: 'cli', expiresAt: 1 },
  });
  r.alive.add(7100);
  await seed(cfg, decoy);
  fs.mkdirSync(devDir(cfg, x.deviceId), { recursive: true });
  r.onRun(
    (c, a) => c === cfg.adbBin && a.join(' ') === '-s emulator-5680 emu kill',
    () => {
      const st = readState(cfg.stateFile);
      st.leases.push(x);
      fs.writeFileSync(cfg.stateFile, JSON.stringify(st));
      return { code: 0, stdout: '', stderr: '' };
    },
  );
}

const reuseReq = (serial: string, flavor: 'clean' | 'signed-in' = 'clean') => ({
  flavor,
  project: '/q',
  owner: { kind: 'mcp' as const, pid: process.pid },
  reuseSerial: serial,
});

test('reuseSerial past grace gets a fresh device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  r.alive.add(7001);
  const goneSince = Date.now() - cfg.ownerGraceMs - 1000;
  await injectAfterEntryReap(r, cfg, lease({ owner: { kind: 'mcp', pid: DEAD_PID, goneSince } }));
  const info = await getDevice(r, cfg, reuseReq('emulator-5620'));
  assert.notEqual(info.deviceId, 'dev-aaaaaa');
  assert.notEqual(info.serial, 'emulator-5620');
  assert.equal(cpCalls(r), 1);
  const orig = readState(cfg.stateFile).leases.find((l) => l.deviceId === 'dev-aaaaaa')!;
  assert.deepEqual(orig.owner, { kind: 'mcp', pid: DEAD_PID, goneSince });
  assert.equal(orig.project, '/p');
});

test('reuseSerial with dead emulator gets a fresh device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  const goneSince = Date.now() - 1000;
  await injectAfterEntryReap(
    r,
    cfg,
    lease({ emulatorPid: DEAD_PID, owner: { kind: 'mcp', pid: DEAD_PID, goneSince } }),
  );
  const info = await getDevice(r, cfg, reuseReq('emulator-5620'));
  assert.notEqual(info.deviceId, 'dev-aaaaaa');
  assert.notEqual(info.serial, 'emulator-5620');
  assert.equal(cpCalls(r), 1);
  const orig = readState(cfg.stateFile).leases.find((l) => l.deviceId === 'dev-aaaaaa')!;
  assert.deepEqual(orig.owner, { kind: 'mcp', pid: DEAD_PID, goneSince });
});

test('reuseSerial same owner returns its lease', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(7001).add(process.pid);
  await seed(cfg, lease({ owner: { kind: 'mcp', pid: process.pid } }));
  const info = await getDevice(r, cfg, reuseReq('emulator-5620'));
  assert.equal(info.deviceId, 'dev-aaaaaa');
  assert.equal(info.project, '/p');
  assert.equal(cpCalls(r), 0);
  assert.equal(readState(cfg.stateFile).leases.length, 1);
});

test('reuseSerial on booting lease says still booting', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  await seed(cfg, lease({ state: 'booting', emulatorPid: 0, owner: { kind: 'mcp', pid: DEAD_PID } }));
  await assert.rejects(getDevice(r, cfg, reuseReq('emulator-5620')), {
    message: 'device emulator-5620 is still booting',
  });
  assert.equal(cpCalls(r), 0);
});

test('reuseSerial flavor mismatch gets a fresh device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001);
  r.alive.add(7001);
  const goneSince = Date.now() - 1000;
  await seed(cfg, lease({ flavor: 'signed-in', owner: { kind: 'mcp', pid: DEAD_PID, goneSince } }));
  const info = await getDevice(r, cfg, reuseReq('emulator-5620'));
  assert.notEqual(info.deviceId, 'dev-aaaaaa');
  assert.equal(info.serial, 'emulator-5622');
  assert.equal(info.flavor, 'clean');
  const orig = readState(cfg.stateFile).leases.find((l) => l.deviceId === 'dev-aaaaaa')!;
  assert.deepEqual(orig.owner, { kind: 'mcp', pid: DEAD_PID, goneSince });
});

test('reap continues past a failing teardown', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  const now = Date.now();
  const expired = { kind: 'cli' as const, expiresAt: now - 1 };
  await seed(
    cfg,
    lease({ emulatorPid: DEAD_PID, owner: expired }),
    lease({ deviceId: 'dev-bbbbbb', serial: 'emulator-5622', port: 5622, emulatorPid: DEAD_PID, owner: expired }),
  );
  const stuck = devDir(cfg, 'dev-aaaaaa');
  fs.writeFileSync(path.join(stuck, 'userdata-qemu.img'), 'x');
  fs.chmodSync(stuck, 0o500); // its contents can no longer be removed
  const err = captureStderr();
  let removed: string[];
  try {
    removed = await reap(r, cfg, now);
  } finally {
    err.restore();
    fs.chmodSync(stuck, 0o700);
  }
  assert.deepEqual(removed, ['dev-bbbbbb']);
  assert.deepEqual(readState(cfg.stateFile).leases.map((l) => l.deviceId), ['dev-aaaaaa']);
  assert.ok(!fs.existsSync(devDir(cfg, 'dev-bbbbbb')));
  assert.match(err.text(), /^droidpool: reap: dev-aaaaaa/m);
});
