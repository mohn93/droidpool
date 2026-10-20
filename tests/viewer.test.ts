import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { FakeRunner } from './fakes.ts';
import { readState, withState, type Lease } from '../src/state.ts';
import { releaseDevice } from '../src/pool.ts';
import { ensureScrcpy, scrcpyDir, showDevice, SCRCPY_VERSION } from '../src/viewer.ts';

const TARBALL = Buffer.from('fake scrcpy tarball');
const SHA = crypto.createHash('sha256').update(TARBALL).digest('hex');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-view-'));
  const cfg: Config = { ...loadConfig({ HOME: tmp }), killWaitMs: 20 };
  fs.mkdirSync(cfg.logsDir, { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases: [], leases: [] }));
  return { cfg };
}

/** A runner whose `tar -xzf` creates the scrcpy binary, like the real release tarball. */
function tarRunner(): FakeRunner {
  const r = new FakeRunner();
  r.onRun(
    (c) => c === 'tar',
    (_c, a) => {
      const dest = a[a.indexOf('-C') + 1]!;
      const dir = path.join(dest, `scrcpy-macos-aarch64-${SCRCPY_VERSION}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'scrcpy'), '#!/bin/sh\n');
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  return r;
}

function opts(downloads: string[]) {
  return {
    arch: 'arm64',
    checksums: { aarch64: SHA },
    download: async (url: string) => {
      downloads.push(url);
      return TARBALL;
    },
  };
}

function lease(over: Partial<Lease> = {}): Lease {
  return {
    deviceId: 'dev-aaaaa0',
    serial: 'emulator-5620',
    port: 5620,
    emulatorPid: 7000,
    flavor: 'clean',
    api: 35,
    project: '/Users/x/apps/shop',
    owner: { kind: 'cli', expiresAt: Date.now() + 60_000 },
    createdAt: Date.now(),
    state: 'ready',
    ...over,
  };
}

test('scrcpyDir is pinned per arch under the droidpool home', () => {
  const { cfg } = setup();
  assert.equal(scrcpyDir(cfg, 'arm64'), path.join(cfg.home, 'tools', `scrcpy-macos-aarch64-${SCRCPY_VERSION}`));
  assert.equal(scrcpyDir(cfg, 'x64'), path.join(cfg.home, 'tools', `scrcpy-macos-x86_64-${SCRCPY_VERSION}`));
});

test('ensureScrcpy downloads the pinned release once', async () => {
  const { cfg } = setup();
  const r = tarRunner();
  const downloads: string[] = [];
  const bin = await ensureScrcpy(r, cfg, opts(downloads));
  assert.equal(bin, path.join(scrcpyDir(cfg, 'arm64'), 'scrcpy'));
  assert.ok(fs.existsSync(bin));
  assert.deepEqual(downloads, [
    `https://github.com/Genymobile/scrcpy/releases/download/${SCRCPY_VERSION}/scrcpy-macos-aarch64-${SCRCPY_VERSION}.tar.gz`,
  ]);
  assert.equal(fs.readdirSync(path.join(cfg.home, 'tools')).filter((f) => f.endsWith('.tar.gz')).length, 0);

  await ensureScrcpy(r, cfg, opts(downloads));
  assert.equal(downloads.length, 1);
});

test('ensureScrcpy rejects a tarball with the wrong checksum', async () => {
  const { cfg } = setup();
  const r = tarRunner();
  await assert.rejects(
    ensureScrcpy(r, cfg, { ...opts([]), checksums: { aarch64: '0'.repeat(64) } }),
    /scrcpy download checksum mismatch/,
  );
  assert.ok(!r.calls.some((c) => c.cmd === 'tar'));
  assert.ok(!fs.existsSync(scrcpyDir(cfg, 'arm64')));
});

test('showDevice mirrors the device with the SDK adb and records the viewer', async () => {
  const { cfg } = setup();
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease());
  });
  const r = tarRunner().onSpawn(8100);
  const msg = await showDevice(r, cfg, 'emulator-5620', opts([]));
  assert.match(msg, /showing emulator-5620/);
  const spawn = r.calls.find((c) => c.kind === 'spawn')!;
  assert.equal(spawn.cmd, path.join(scrcpyDir(cfg, 'arm64'), 'scrcpy'));
  assert.deepEqual(spawn.args, ['-s', 'emulator-5620', '--window-title', 'emulator-5620 (shop)', '--no-audio']);
  assert.equal(spawn.env!.ADB, cfg.adbBin);
  assert.equal(spawn.logFile, path.join(cfg.logsDir, 'dev-aaaaa0-scrcpy.log'));
  assert.equal(readState(cfg.stateFile).leases[0]!.viewerPid, 8100);
});

test('showDevice does not open a second window while one is open', async () => {
  const { cfg } = setup();
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease({ viewerPid: 8100 }));
  });
  const r = tarRunner();
  r.alive.add(8100);
  assert.match(await showDevice(r, cfg, 'emulator-5620', opts([])), /already showing emulator-5620/);
  assert.ok(!r.calls.some((c) => c.kind === 'spawn'));
});

test('showDevice refuses unknown and booting devices', async () => {
  const { cfg } = setup();
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease({ state: 'booting' }));
  });
  const r = tarRunner();
  await assert.rejects(showDevice(r, cfg, 'emulator-5699', opts([])), /no device emulator-5699/);
  await assert.rejects(showDevice(r, cfg, 'emulator-5620', opts([])), /device emulator-5620 is still booting/);
});

test('releasing a device closes its viewer', async () => {
  const { cfg } = setup();
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease({ viewerPid: 8100 }));
  });
  const r = new FakeRunner();
  r.alive.add(7000);
  r.alive.add(8100);
  const res = await releaseDevice(r, cfg, 'emulator-5620');
  assert.equal(res.released, true);
  assert.ok(r.killed.some((k) => k.pid === 8100));
});

test('concurrent first installs both end with one complete copy', async () => {
  const { cfg } = setup();
  const r = tarRunner();
  const [a, b] = await Promise.all([ensureScrcpy(r, cfg, opts([])), ensureScrcpy(r, cfg, opts([]))]);
  assert.equal(a, b);
  assert.ok(fs.existsSync(a));
  // Only the installed release remains: no tarballs or staging dirs.
  assert.deepEqual(fs.readdirSync(path.join(cfg.home, 'tools')), [`scrcpy-macos-aarch64-${SCRCPY_VERSION}`]);
});

test('a failed unpack leaves no install behind', async () => {
  const { cfg } = setup();
  const r = new FakeRunner().onRun((c) => c === 'tar', { code: 1, stdout: '', stderr: 'truncated' });
  await assert.rejects(ensureScrcpy(r, cfg, opts([])), /scrcpy unpack failed: truncated/);
  assert.deepEqual(fs.readdirSync(path.join(cfg.home, 'tools')), []);
});

test('showDevice keeps the window a concurrent show recorded first', async () => {
  const { cfg } = setup();
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease());
  });
  const r = tarRunner().onSpawn(8200);
  r.alive.add(8100);
  // The other show records its window after this one read the lease.
  r.onRun(
    (c) => c === 'tar',
    (_c, a) => {
      const dest = a[a.indexOf('-C') + 1]!;
      const dir = path.join(dest, `scrcpy-macos-aarch64-${SCRCPY_VERSION}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'scrcpy'), '#!/bin/sh\n');
      const st = readState(cfg.stateFile);
      st.leases[0]!.viewerPid = 8100;
      fs.writeFileSync(cfg.stateFile, JSON.stringify(st));
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  assert.match(await showDevice(r, cfg, 'emulator-5620', opts([])), /already showing emulator-5620/);
  assert.deepEqual(r.killed, [{ pid: 8200, signal: 'SIGTERM', group: true }]);
  assert.equal(readState(cfg.stateFile).leases[0]!.viewerPid, 8100);
});
