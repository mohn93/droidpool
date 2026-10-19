import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readState, withState } from '../src/state.ts';
import type { Lease } from '../src/state.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'droidpool-state-'));
}

function lease(port: number): Lease {
  return {
    deviceId: 'dev-aaaaaa',
    serial: `emulator-${port}`,
    port,
    emulatorPid: 1,
    flavor: 'clean',
    api: 35,
    project: 'p',
    owner: { kind: 'cli', expiresAt: 0 },
    createdAt: 0,
    state: 'ready',
  };
}

test('empty when missing', () => {
  const dir = tmpDir();
  assert.deepEqual(readState(path.join(dir, 'state.json')), { bases: [], leases: [] });
});

test('withState persists mutation', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'state.json');
  const result = await withState(file, async (s) => {
    s.leases.push(lease(5620));
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(readState(file).leases.length, 1);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('lock is released when fn throws', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  await assert.rejects(
    withState(file, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(fs.existsSync(file + '.lock'), false);
});

async function runEightWriters(file: string): Promise<void> {
  const stateUrl = pathToFileURL(path.resolve('src/state.ts')).href;
  const script = `
    import { withState } from ${JSON.stringify(stateUrl)};
    const file = process.argv[1];
    for (let i = 0; i < 25; i++) {
      await withState(file, (s) => {
        if (s.leases.length === 0) {
          s.leases.push({ deviceId: 'dev-aaaaaa', serial: 'emulator-0', port: 0, emulatorPid: 1, flavor: 'clean', api: 35, project: 'p', owner: { kind: 'cli', expiresAt: 0 }, createdAt: 0, state: 'ready' });
        }
        s.leases[0].port += 1;
      });
    }
  `;
  const run = (): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, file],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      child.on('error', reject);
      child.on('exit', resolve);
    });
  const codes = await Promise.all(Array.from({ length: 8 }, run));
  assert.deepEqual(codes, new Array(8).fill(0));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.leases[0].port, 200);
  assert.equal(readState(file).leases[0].port, 200);
}

test('concurrent writers serialize', async () => {
  await runEightWriters(path.join(tmpDir(), 'state.json'));
});

test('concurrent breakers of a dead lock serialize', async () => {
  const file = path.join(tmpDir(), 'state.json');
  fs.mkdirSync(file + '.lock');
  fs.writeFileSync(path.join(file + '.lock', 'owner'), '999999');
  await runEightWriters(file);
});

test('release does not delete a lock it no longer owns', async () => {
  const file = path.join(tmpDir(), 'state.json');
  await withState(file, (s) => {
    s.leases.push(lease(5624));
  });
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(
    withState(file, (s) => {
      s.leases.push(lease(5626));
      fs.rmSync(file + '.lock', { recursive: true });
      fs.mkdirSync(file + '.lock');
      fs.writeFileSync(path.join(file + '.lock', 'owner'), '1');
    }),
    /state lock lost/,
  );
  assert.equal(fs.existsSync(file + '.lock'), true);
  assert.equal(fs.readFileSync(path.join(file + '.lock', 'owner'), 'utf8'), '1');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('stale lock is broken', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  fs.mkdirSync(file + '.lock');
  fs.writeFileSync(path.join(file + '.lock', 'owner'), '999999');
  const start = Date.now();
  await withState(file, (s) => {
    s.leases.push(lease(5622));
  });
  assert.ok(Date.now() - start < 2000);
  assert.equal(readState(file).leases.length, 1);
});

test('lock older than 30s is broken even if owner is alive', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  const lock = file + '.lock';
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const start = Date.now();
  await withState(file, () => {});
  assert.ok(Date.now() - start < 2000);
});
