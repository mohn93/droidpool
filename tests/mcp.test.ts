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
import { deviceIni } from '../src/avdfiles.ts';
import { createServer, shutdown } from '../src/mcp.ts';

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

test('lists three tools', async () => {
  const { cfg } = setup();
  const { client, close } = await connect(cfg, fakeRunner(cfg));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_device', 'list_devices', 'release_device']);
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

test('shutdown releases owned devices only', async () => {
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
  const leases = [mk(0, { kind: 'mcp', pid: PID }), mk(1, { kind: 'mcp', pid: OTHER_PID })];
  await withState(cfg.stateFile, (s) => {
    s.leases.push(...leases);
  });
  for (const l of leases) {
    const dir = path.join(cfg.avdHome, `${l.deviceId}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(cfg.avdHome, `${l.deviceId}.ini`), deviceIni(dir, 35));
  }
  await shutdown({ runner: r, cfg, pid: PID });
  const left = readState(cfg.stateFile).leases;
  assert.deepEqual(left.map((l) => l.deviceId), ['dev-aaaaa1']);
});
