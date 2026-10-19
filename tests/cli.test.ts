import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { FakeRunner } from './fakes.ts';
import { withState, type BaseRecord } from '../src/state.ts';
import { deviceIni } from '../src/avdfiles.ts';
import { runCli } from '../src/cli.ts';
import { doctorReport } from '../src/doctor.ts';

const VERSION = '36.5.11';

function setup(baseVersion = VERSION) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cli-'));
  const cfg: Config = {
    ...loadConfig({ HOME: tmp }),
    bootPollMs: 2,
    killWaitMs: 20,
    queuePollMs: 10,
    freeBytesFn: () => 100 * 2 ** 30,
    cloneProbe: { dev: () => 1, fsType: () => 26 },
  };
  fs.mkdirSync(cfg.avdHome, { recursive: true });
  const baseDir = path.join(cfg.avdHome, 'base-clean-35.avd');
  fs.mkdirSync(path.join(baseDir, 'snapshots', 'default_boot'), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'snapshots', 'default_boot', 'hardware.ini'),
    `avd.name = base-clean-35\ndisk.dataPartition.path = ${baseDir}/userdata-qemu.img\n`,
  );
  const rec: BaseRecord = {
    name: 'base-clean-35',
    flavor: 'clean',
    api: 35,
    image: 'system-images;android-35;google_apis;arm64-v8a',
    emulatorVersion: baseVersion,
    ramMb: 4096,
    builtAt: 'x',
  };
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [rec], leases: [] }));
  return { cfg, baseDir };
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

async function run(cfg: Config, r: FakeRunner, argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    runner: r,
    cfg,
    out: (s) => (out += s),
    err: (s) => (err += s),
    waitForUser: async () => {},
  });
  return { code, out, err };
}

test('get prints serial only', async () => {
  const { cfg } = setup();
  const r = await run(cfg, fakeRunner(cfg).onSpawn(5001), ['get']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'emulator-5620\n');
});

test('get error goes to stderr with exit 1', async () => {
  const { cfg } = setup();
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [], leases: [] }));
  const r = await run(cfg, fakeRunner(cfg).onSpawn(5001), ['get']);
  assert.equal(r.code, 1);
  assert.match(r.err, /droidpool base build clean --api 35/);
  assert.equal(r.out, '');
});

test('unknown command', async () => {
  const { cfg } = setup();
  const r = await run(cfg, fakeRunner(cfg), ['frob']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: droidpool/);
  assert.equal(r.out, '');
});

test('bad flag is a usage error', async () => {
  const { cfg } = setup();
  const r = await run(cfg, fakeRunner(cfg), ['get', '--nope']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: droidpool/);
});

test('ls shows leases', async () => {
  const { cfg } = setup();
  const fr = fakeRunner(cfg).onSpawn(5001);
  await run(cfg, fr, ['get', '--project', '/proj']);
  const r = await run(cfg, fr, ['ls']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^SERIAL +ID +FLAVOR +API +PROJECT +OWNER +STATE$/m);
  assert.match(r.out, /emulator-5620 +dev-[0-9a-f]{6} +clean +35 +\/proj +cli +ready/);
});

test('release removes the device and renew extends it', async () => {
  const { cfg } = setup();
  const fr = fakeRunner(cfg).onSpawn(5001);
  await run(cfg, fr, ['get']);
  assert.equal((await run(cfg, fr, ['renew', 'emulator-5620'])).code, 0);
  const rel = await run(cfg, fr, ['release', 'emulator-5620']);
  assert.equal(rel.code, 0);
  assert.doesNotMatch((await run(cfg, fr, ['ls'])).out, /emulator-5620/);
  assert.equal((await run(cfg, fr, ['release', 'emulator-5620'])).code, 1);
});

test('every command reaps first', async () => {
  const { cfg } = setup();
  const id = 'dev-aaaaaa';
  const dir = path.join(cfg.avdHome, `${id}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.avdHome, `${id}.ini`), deviceIni(dir, 35));
  await withState(cfg.stateFile, (s) => {
    s.leases.push({
      deviceId: id,
      serial: 'emulator-5620',
      port: 5620,
      emulatorPid: 7001,
      flavor: 'clean',
      api: 35,
      project: '/p',
      owner: { kind: 'cli', expiresAt: Date.now() - 1000 },
      createdAt: Date.now() - 10_000,
      state: 'ready',
    });
  });
  const fr = fakeRunner(cfg);
  fr.alive.add(7001);
  const r = await run(cfg, fr, ['ls']);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /emulator-5620/);
  assert.ok(!fs.existsSync(dir));
});

test('base list and rm', async () => {
  const { cfg } = setup();
  const fr = fakeRunner(cfg);
  assert.match((await run(cfg, fr, ['base', 'list'])).out, /base-clean-35 +clean +35 +36\.5\.11/);
  assert.equal((await run(cfg, fr, ['base', 'rm', 'base-clean-35'])).code, 0);
  assert.equal((await run(cfg, fr, ['base', 'rm', 'base-clean-35'])).code, 1);
});

test('doctor', async () => {
  const { cfg } = setup();
  const fr = fakeRunner(cfg).onRun((c) => c === 'du', { code: 0, stdout: '1.4G\ttotal\n', stderr: '' });
  const r = await run(cfg, fr, ['doctor']);
  assert.equal(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  assert.deepEqual(lines, [
    'emulator: 36.5.11',
    'bases: 1',
    'devices: 0',
    'free disk: 100.0 GB (need 9.2 GB per device)',
    'bases on disk: 1.4G',
  ]);
});

test('doctor warns on stale base and survives missing emulator', async () => {
  const { cfg } = setup('36.0.0');
  const fr = fakeRunner(cfg).onRun((c) => c === 'du', { code: 0, stdout: '1G\ttotal\n', stderr: '' });
  const out = await doctorReport(fr, cfg);
  assert.match(out, /^warning: base base-clean-35 built on 36\.0\.0, emulator is 36\.5\.11; rebuild it$/m);
  const bad = new FakeRunner().onRun(() => true, { code: 1, stdout: 'nope', stderr: '' });
  assert.match(await doctorReport(bad, cfg), /^emulator: unavailable \(/m);
});

test('doctor with no bases', async () => {
  const { cfg } = setup();
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [], leases: [] }));
  assert.match(await doctorReport(fakeRunner(cfg), cfg), /^bases on disk: 0$/m);
});

test('gc prints removed ids', async () => {
  const { cfg } = setup();
  const id = 'dev-bbbbbb';
  const dir = path.join(cfg.avdHome, `${id}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.avdHome, `${id}.ini`), deviceIni(dir, 35));
  await withState(cfg.stateFile, (s) => {
    s.leases.push({
      deviceId: id, serial: 'emulator-5622', port: 5622, emulatorPid: 7002, flavor: 'clean', api: 35,
      project: '/p', owner: { kind: 'cli', expiresAt: Date.now() - 1000 }, createdAt: Date.now() - 10_000, state: 'ready',
    });
  });
  const fr = fakeRunner(cfg);
  fr.alive.add(7002);
  const r = await run(cfg, fr, ['gc']);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${id}\n`);
  assert.ok(!fs.existsSync(dir));
});
