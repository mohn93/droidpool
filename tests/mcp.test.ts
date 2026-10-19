import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../src/config.ts';
import { FakeRunner } from './fakes.ts';
import { readState, withState, type BaseRecord, type Lease } from '../src/state.ts';
import { createServer, markGone, scheduleReaper } from '../src/mcp.ts';
import { reap } from '../src/pool.ts';
import { scrcpyDir } from '../src/viewer.ts';

const VERSION = '36.5.11';
const PID = 4242;
const OTHER_PID = 4343;

function setup(withBase = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mcp-'));
  const cfg: Config = {
    ...loadConfig({ HOME: tmp }),
    bootPollMs: 2,
    killWaitMs: 20,
    queuePollMs: 10,
    freeBytesFn: () => 100 * 2 ** 30,
    cloneProbe: { dev: () => 1, fsType: () => 26 },
  };
  fs.mkdirSync(cfg.avdHome, { recursive: true });
  const bases: BaseRecord[] = [];
  if (withBase) {
    const baseDir = path.join(cfg.avdHome, 'base-clean-35.avd');
    fs.mkdirSync(path.join(baseDir, 'snapshots', 'default_boot'), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'snapshots', 'default_boot', 'hardware.ini'),
      `avd.name = base-clean-35\ndisk.dataPartition.path = ${baseDir}/userdata-qemu.img\n`,
    );
    bases.push({
      name: 'base-clean-35',
      flavor: 'clean',
      api: 35,
      image: 'system-images;android-35;google_apis;arm64-v8a',
      emulatorVersion: VERSION,
      ramMb: 4096,
      builtAt: 'x',
    });
  }
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ bases, leases: [] }));
  return { cfg };
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

async function connect(cfg: Config, runner: FakeRunner) {
  const server = createServer({ runner, cfg, pid: PID });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: () => client.close() };
}

function text(res: unknown): string {
  const c = (res as { content: { type: string; text: string }[] }).content;
  assert.equal(c.length, 1);
  return c[0]!.text;
}

test('lists four tools', async () => {
  const { cfg } = setup();
  const { client, close } = await connect(cfg, fakeRunner(cfg));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_device', 'list_devices', 'release_device', 'show_device']);
  await close();
});

test('get_device returns serial', async () => {
  const { cfg } = setup();
  const { client, close } = await connect(cfg, fakeRunner(cfg).onSpawn(5001));
  const res = await client.callTool({ name: 'get_device', arguments: { project: '/p' } });
  assert.notEqual(res.isError, true);
  const body = JSON.parse(text(res));
  assert.equal(body.serial, 'emulator-5620');
  assert.equal(body.flavor, 'clean');
  assert.equal(body.api, 35);
  assert.deepEqual(readState(cfg.stateFile).leases[0]!.owner, { kind: 'mcp', pid: PID });
  const list = await client.callTool({ name: 'list_devices', arguments: {} });
  assert.equal(JSON.parse(text(list))[0].serial, 'emulator-5620');
  const rel = await client.callTool({ name: 'release_device', arguments: { serial: 'emulator-5620' } });
  assert.match(text(rel), /^released emulator-5620/);
  await close();
});

test('errors are tool errors, not crashes', async () => {
  const { cfg } = setup(false);
  const { client, close } = await connect(cfg, fakeRunner(cfg));
  const res = await client.callTool({ name: 'get_device', arguments: { project: '/p' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /droidpool base build clean --api 35/);
  await close();
});

test('mcp release_device refuses another live session\'s device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(OTHER_PID).add(7001);
  const l: Lease = {
    deviceId: 'dev-aaaaa0',
    serial: 'emulator-5620',
    port: 5620,
    emulatorPid: 7001,
    flavor: 'clean',
    api: 35,
    project: '/p',
    owner: { kind: 'mcp', pid: OTHER_PID },
    createdAt: Date.now(),
    state: 'ready',
  };
  await withState(cfg.stateFile, (s) => {
    s.leases.push(l);
  });
  const { client, close } = await connect(cfg, r);
  const res = await client.callTool({ name: 'release_device', arguments: { serial: 'emulator-5620' } });
  assert.equal(res.isError, true);
  assert.equal(text(res), 'device emulator-5620 belongs to another session');
  assert.equal(readState(cfg.stateFile).leases.length, 1);
  assert.ok(r.isAlive(7001));
  assert.ok(!r.calls.some((c) => c.args.includes('kill')));
  // Once that owner is gone, the device may be released by anyone.
  r.alive.delete(OTHER_PID);
  const res2 = await client.callTool({ name: 'release_device', arguments: { serial: 'emulator-5620' } });
  assert.notEqual(res2.isError, true);
  assert.match(text(res2), /^released emulator-5620/);
  await close();
});

test('clean exit marks own leases gone and keeps others', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(OTHER_PID);
  const mk = (n: number, owner: Lease['owner']): Lease => ({
    deviceId: `dev-aaaaa${n}`,
    serial: `emulator-${5620 + 2 * n}`,
    port: 5620 + 2 * n,
    emulatorPid: 7000 + n,
    flavor: 'clean',
    api: 35,
    project: '/p',
    owner,
    createdAt: Date.now(),
    state: 'ready',
  });
  const cliOwner = { kind: 'cli' as const, expiresAt: Date.now() + 60_000 };
  const leases = [
    mk(0, { kind: 'mcp', pid: PID }),
    mk(1, { kind: 'mcp', pid: OTHER_PID }),
    mk(2, cliOwner),
    mk(3, { kind: 'mcp', pid: PID }),
  ];
  await withState(cfg.stateFile, (s) => {
    s.leases.push(...leases);
  });
  const t0 = Date.now();
  assert.equal(await markGone({ runner: r, cfg, pid: PID }), 2);
  const left = readState(cfg.stateFile).leases;
  assert.deepEqual(left.map((l) => l.deviceId), ['dev-aaaaa0', 'dev-aaaaa1', 'dev-aaaaa2', 'dev-aaaaa3']);
  for (const i of [0, 3]) {
    const o = left[i]!.owner;
    assert.ok(o.kind === 'mcp' && o.goneSince !== undefined && o.goneSince >= t0 && o.goneSince <= Date.now());
  }
  assert.deepEqual(left[1]!.owner, { kind: 'mcp', pid: OTHER_PID });
  assert.deepEqual(left[2]!.owner, cliOwner);
  assert.ok(!r.calls.some((c) => c.args.includes('kill')));

  scheduleReaper(r, cfg);
  const spawns = r.calls.filter((c) => c.kind === 'spawn');
  assert.equal(spawns.length, 1);
  const sp = spawns[0]!;
  assert.equal(sp.cmd, 'sh');
  assert.equal(sp.args[0], '-c');
  const script = sp.args[1]!;
  assert.match(script, /^sleep 125; exec /); // ceil(120 s grace) + 5
  assert.ok(script.includes(process.execPath));
  assert.ok(script.includes('--disable-warning=ExperimentalWarning'));
  assert.ok(script.includes(path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')));
  assert.match(script, / gc$/);
  assert.equal(sp.logFile, path.join(cfg.logsDir, 'reaper.log'));
  assert.equal(sp.env, process.env);
});

test('reap racing a clean exit keeps the exit mark while the owner pid is alive', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg);
  r.alive.add(PID);
  r.alive.add(7000);
  const lease: Lease = {
    deviceId: 'dev-aaaaa0',
    serial: 'emulator-5620',
    port: 5620,
    emulatorPid: 7000,
    flavor: 'clean',
    api: 35,
    project: '/p',
    owner: { kind: 'mcp', pid: PID },
    createdAt: Date.now(),
    state: 'ready',
  };
  await withState(cfg.stateFile, (s) => {
    s.leases.push(lease);
  });
  fs.mkdirSync(path.join(cfg.avdHome, 'dev-aaaaa0.avd'));
  assert.equal(await markGone({ runner: r, cfg, pid: PID }), 1);
  const marked = readState(cfg.stateFile).leases[0]!.owner;
  assert.ok(marked.kind === 'mcp' && marked.goneSince !== undefined);
  const gone = marked.goneSince;

  // The exiting server's pid is still alive while a queued reap runs.
  assert.deepEqual(await reap(r, cfg, gone + 1000), []);
  const after = readState(cfg.stateFile).leases[0]!.owner;
  assert.ok(after.kind === 'mcp' && after.goneSince === gone);

  // The delayed gc after the grace period removes it.
  assert.deepEqual(await reap(r, cfg, gone + cfg.ownerGraceMs + 1), ['dev-aaaaa0']);
  assert.equal(readState(cfg.stateFile).leases.length, 0);
  assert.ok(!fs.existsSync(path.join(cfg.avdHome, 'dev-aaaaa0.avd')));
});

test('show_device opens a mirror window for the device', async () => {
  const { cfg } = setup();
  const r = fakeRunner(cfg).onSpawn(5001, 8100);
  const { client, close } = await connect(cfg, r);
  const got = JSON.parse(text(await client.callTool({ name: 'get_device', arguments: { project: '/apps/shop' } })));
  const bin = path.join(scrcpyDir(cfg), 'scrcpy');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const res = await client.callTool({ name: 'show_device', arguments: { serial: got.serial } });
  assert.ok(!res.isError);
  assert.match(text(res), /showing emulator-5620/);
  const bad = await client.callTool({ name: 'show_device', arguments: { serial: 'emulator-5699' } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /no device emulator-5699/);
  await close();
});
