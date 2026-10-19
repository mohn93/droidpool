import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { FakeRunner } from './fakes.ts';
import { withState, readState, type BaseRecord, type Lease } from '../src/state.ts';
import { TUNED_CONFIG } from '../src/avdfiles.ts';
import {
  abortCurrentBuild,
  assertBaseUsable,
  buildBase,
  baseName,
  currentBuildPid,
  imageFor,
  listBases,
  removeBase,
} from '../src/base.ts';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-base-'));
  const cfg: Config = {
    ...loadConfig({ HOME: tmp }),
    baseSettleMs: 0,
    bootPollMs: 1,
    killWaitMs: 50,
  };
  fs.mkdirSync(cfg.avdHome, { recursive: true });
  return { tmp, cfg };
}

function emulatorFake(version: string): FakeRunner {
  return new FakeRunner().onRun(
    (c, a) => c.endsWith('/emulator') && a[0] === '-version',
    { code: 0, stdout: `Android emulator version ${version} (build_id 1)\n`, stderr: '' },
  );
}

function scriptBuild(r: FakeRunner, cfg: Config, name: string, snapshotOk = true): void {
  r.onRun((c) => c === cfg.sdkmanagerBin, { code: 0, stdout: '', stderr: '' });
  r.onRun(
    (c) => c === cfg.avdmanagerBin,
    () => {
      const dir = path.join(cfg.avdHome, `${name}.avd`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.ini'), 'hw.ramSize=2048\nhw.lcd.width=1080\n');
      fs.writeFileSync(path.join(cfg.avdHome, `${name}.ini`), `path=${dir}\n`);
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  r.onRun((c, a) => c === cfg.adbBin && a.includes('getprop'), { code: 0, stdout: '1\n', stderr: '' });
  r.onRun(
    (c, a) => c === cfg.adbBin && a.includes('snapshot'),
    snapshotOk ? { code: 0, stdout: 'OK\n', stderr: '' } : { code: 1, stdout: 'KO\n', stderr: 'boom' },
  );
  r.onRun((c, a) => c === cfg.adbBin && a.includes('kill'), () => {
    r.alive.clear();
    return { code: 0, stdout: 'OK: killing emulator\n', stderr: '' };
  });
  r.onSpawn(4242);
}

const io = () => {
  const prompts: string[] = [];
  return {
    prompts,
    waitForUser: async (p: string) => {
      prompts.push(p);
    },
    log: () => {},
  };
};

test('names and images', () => {
  assert.equal(baseName('clean', 35), 'base-clean-35');
  assert.equal(baseName('signed-in', 35), 'base-signed-in-35');
  assert.equal(imageFor('clean', 35), 'system-images;android-35;google_apis;arm64-v8a');
  assert.equal(imageFor('signed-in', 35), 'system-images;android-35;google_apis_playstore;arm64-v8a');
});

test('assertBaseUsable missing', async () => {
  const { cfg } = setup();
  await assert.rejects(
    assertBaseUsable(emulatorFake('36.5.11'), cfg, 'clean', 35),
    { message: 'no base for clean API 35. Build one: droidpool base build clean --api 35' },
  );
});

test('assertBaseUsable version mismatch', async () => {
  const { cfg } = setup();
  const rec: BaseRecord = {
    name: 'base-clean-35',
    flavor: 'clean',
    api: 35,
    image: imageFor('clean', 35),
    emulatorVersion: '36.5.11',
    ramMb: 4096,
    builtAt: 'x',
  };
  await withState(cfg.stateFile, (s) => {
    s.bases.push(rec);
  });
  await assert.rejects(assertBaseUsable(emulatorFake('36.6.11'), cfg, 'clean', 35), {
    message:
      'base base-clean-35 was built on emulator 36.5.11; emulator is now 36.6.11. Rebuild: droidpool base build clean --api 35',
  });
  assert.deepEqual(await assertBaseUsable(emulatorFake('36.5.11'), cfg, 'clean', 35), rec);
});

test('assertBaseUsable rejects unsupported api', async () => {
  const { cfg } = setup();
  await assert.rejects(assertBaseUsable(emulatorFake('36.5.11'), cfg, 'clean', 36), {
    message: 'API 36 not supported in v1 (supported: 35)',
  });
});

test('buildBase clean sequence', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35');
  const i = io();
  const rec = await buildBase(r, cfg, 'clean', 35, i);

  const calls = r.calls.filter(
    (c) => !(c.args[0] === '-version') && !c.args.includes('getprop') && c.args[0] !== 'devices',
  );
  const image = 'system-images;android-35;google_apis;arm64-v8a';
  assert.equal(calls[0]!.cmd, cfg.sdkmanagerBin);
  assert.deepEqual(calls[0]!.args, [image]);
  assert.equal(calls[0]!.input, 'y\n');
  assert.equal(calls[1]!.cmd, cfg.avdmanagerBin);
  assert.deepEqual(calls[1]!.args, ['create', 'avd', '-n', 'base-clean-35', '-k', image, '-d', 'pixel_7', '--force']);
  assert.equal(calls[1]!.input, 'no\n');
  assert.equal(calls[1]!.env!.ANDROID_AVD_HOME, cfg.avdHome);
  assert.equal(calls[2]!.kind, 'spawn');
  // The explicit save must be the only write: an exit-time quickboot save races the kill
  // and can leave a truncated ram.bin.
  assert.ok(calls[2]!.args.includes('-no-snapshot-save'));
  assert.ok(calls[2]!.args.includes('-no-window'));
  assert.deepEqual(calls[2]!.args.slice(0, 4), ['-avd', 'base-clean-35', '-port', '5682']);
  assert.deepEqual(
    calls.slice(3, 6).map((c) => c.args.slice(-3).join(' ')),
    ['window_animation_scale 0', 'transition_animation_scale 0', 'animator_duration_scale 0'].map((x) => `global ${x}`),
  );
  assert.ok(calls[6]!.args.join(' ').includes('emu avd snapshot save default_boot'));
  assert.ok(calls[7]!.args.join(' ').includes('emu kill'));
  assert.equal(calls.length, 8);

  const ini = fs.readFileSync(path.join(cfg.avdHome, 'base-clean-35.avd', 'config.ini'), 'utf8');
  for (const [k, v] of Object.entries(TUNED_CONFIG)) assert.ok(ini.includes(`${k}=${v}\n`), k);
  assert.ok(ini.includes('hw.lcd.width=1080'));

  const st = readState(cfg.stateFile);
  assert.equal(st.bases.length, 1);
  assert.equal(st.bases[0]!.ramMb, 4096);
  assert.equal(st.bases[0]!.emulatorVersion, '36.5.11');
  assert.deepEqual(st.bases[0], rec);
  assert.deepEqual(listBases(cfg), [rec]);
  assert.equal(i.prompts.length, 0);
  assert.equal(r.alive.size, 0);
});

test('buildBase signed-in waits for user', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-signed-in-35');
  const order: string[] = [];
  const i = {
    log: () => {},
    waitForUser: async (p: string) => {
      order.push('wait');
      assert.ok(p.includes('Sign in to Google and Play'));
    },
  };
  r.onRun(
    (c, a) => c === cfg.adbBin && a.includes('snapshot'),
    () => {
      order.push('snapshot');
      return { code: 0, stdout: 'OK\n', stderr: '' };
    },
  );
  const rec = await buildBase(r, cfg, 'signed-in', 35, i);
  assert.equal(rec.image, 'system-images;android-35;google_apis_playstore;arm64-v8a');
  assert.deepEqual(order, ['wait', 'snapshot']);
  const spawn = r.calls.find((c) => c.kind === 'spawn')!;
  assert.ok(!spawn.args.includes('-no-window'));
  assert.ok(spawn.args.includes('-no-snapshot-save'));
  assert.ok(r.calls.some((c) => c.args.includes('system-images;android-35;google_apis_playstore;arm64-v8a')));
});

test('buildBase failure removes partial base', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35', false);
  await assert.rejects(buildBase(r, cfg, 'clean', 35, io()), /snapshot save failed/);
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd')));
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.ini')));
  assert.equal(readState(cfg.stateFile).bases.length, 0);
  assert.equal(r.alive.size, 0);
});

test('buildBase failure over an existing base drops its record', async () => {
  const { cfg } = setup();
  const old: BaseRecord = {
    name: 'base-clean-35',
    flavor: 'clean',
    api: 35,
    image: imageFor('clean', 35),
    emulatorVersion: '36.5.11',
    ramMb: 4096,
    builtAt: 'x',
  };
  await withState(cfg.stateFile, (s) => {
    s.bases.push(old);
  });
  fs.mkdirSync(path.join(cfg.avdHome, 'base-clean-35.avd'), { recursive: true });
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35', false);
  await assert.rejects(buildBase(r, cfg, 'clean', 35, io()), /snapshot save failed/);
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd')));
  assert.ok(!readState(cfg.stateFile).bases.some((b) => b.name === 'base-clean-35'));
});

test('buildBase failure keeps original error when record cleanup fails', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35', false);
  r.onRun(
    (c, a) => c === cfg.adbBin && a.includes('snapshot'),
    () => {
      fs.chmodSync(cfg.home, 0o500); // state lock dir can no longer be created
      return { code: 1, stdout: 'KO\n', stderr: 'boom' };
    },
  );
  try {
    await assert.rejects(buildBase(r, cfg, 'clean', 35, io()), /snapshot save failed/);
  } finally {
    fs.chmodSync(cfg.home, 0o700);
  }
});

test('removeBase refuses with active devices, else removes', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35');
  await buildBase(r, cfg, 'clean', 35, io());
  const lease: Lease = {
    deviceId: 'dev-aaaaaa',
    serial: 'emulator-5620',
    port: 5620,
    emulatorPid: 1,
    flavor: 'clean',
    api: 35,
    project: 'p',
    owner: { kind: 'cli', expiresAt: 1 },
    createdAt: 1,
    state: 'ready',
  };
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease);
  });
  await assert.rejects(removeBase(r, cfg, 'base-clean-35'), {
    message: 'base base-clean-35 has 1 active devices',
  });
  assert.equal(listBases(cfg).length, 1);
  await withState(cfg.stateFile, (s) => {
    s.leases = [];
  });
  await removeBase(r, cfg, 'base-clean-35');
  assert.equal(listBases(cfg).length, 0);
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd')));
  await assert.rejects(removeBase(r, cfg, 'base-clean-35'), /no such base/);
});

test('buildBase uses a port outside the pool range', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35');
  r.onRun((c, a) => c === cfg.adbBin && a[0] === 'devices', {
    code: 0,
    stdout: 'List of devices attached\nemulator-5620\tdevice\nemulator-5682\tdevice\n\n',
    stderr: '',
  });
  await buildBase(r, cfg, 'clean', 35, io());
  const spawn = r.calls.find((c) => c.kind === 'spawn')!;
  const port = Number(spawn.args[spawn.args.indexOf('-port') + 1]);
  assert.ok(port > cfg.portMax, String(port));
  assert.equal(port, 5684);
  assert.ok(r.calls.some((c) => c.args.join(' ') === '-s emulator-5684 emu kill'));
});

test('buildBase fails when every base port is taken', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35');
  const listed = Array.from({ length: 10 }, (_, i) => `emulator-${5682 + 2 * i}\tdevice`).join('\n');
  r.onRun((c, a) => c === cfg.adbBin && a[0] === 'devices', { code: 0, stdout: `List of devices attached\n${listed}\n`, stderr: '' });
  await assert.rejects(buildBase(r, cfg, 'clean', 35, io()), { message: 'no free port for base build' });
  assert.ok(!r.calls.some((c) => c.kind === 'spawn'));
});

test('currentBuildPid is set during boot and cleared after', async () => {
  for (const snapshotOk of [true, false]) {
    const { cfg } = setup();
    const r = emulatorFake('36.5.11');
    scriptBuild(r, cfg, 'base-clean-35', snapshotOk);
    const seen: (number | undefined)[] = [];
    r.onRun((c, a) => c === cfg.adbBin && a.includes('getprop'), () => {
      seen.push(currentBuildPid());
      return { code: 0, stdout: '1\n', stderr: '' };
    });
    assert.equal(currentBuildPid(), undefined);
    const build = buildBase(r, cfg, 'clean', 35, io());
    if (snapshotOk) await build;
    else await assert.rejects(build, /snapshot save failed/);
    assert.deepEqual(seen, [4242]);
    assert.equal(currentBuildPid(), undefined);
  }
});

test('abortCurrentBuild kills the base emulator and removes its files', async () => {
  const { cfg } = setup();
  const r = emulatorFake('36.5.11');
  scriptBuild(r, cfg, 'base-clean-35');
  r.onRun((c, a) => c === cfg.adbBin && a.includes('getprop'), () => {
    abortCurrentBuild(r, cfg); // what the CLI SIGINT handler does
    return { code: 1, stdout: '', stderr: 'offline' };
  });
  await assert.rejects(buildBase(r, cfg, 'clean', 35, io()), /emulator exited/);
  assert.deepEqual(r.killed[0], { pid: 4242, signal: 'SIGKILL' });
  assert.equal(currentBuildPid(), undefined);
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'base-clean-35.avd')));
  abortCurrentBuild(r, cfg); // no build running: no-op
  assert.equal(r.killed.length, 1);
});
