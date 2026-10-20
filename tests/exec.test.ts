import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { procAlive, realRunner } from '../src/exec.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('realRunner.run captures output', async () => {
  const r = await realRunner.run('sh', ['-c', 'echo hi; echo err >&2; exit 3']);
  assert.deepEqual(r, { code: 3, stdout: 'hi\n', stderr: 'err\n' });
});

test('realRunner.run times out', async () => {
  const t0 = Date.now();
  const r = await realRunner.run('sleep', ['5'], { timeoutMs: 100 });
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 1000);
});

test('realRunner.spawnDetached writes log and isAlive', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const logFile = path.join(tmp, 'out.log');
  const pid = realRunner.spawnDetached('sh', ['-c', 'echo started; sleep 2'], { logFile });
  assert.ok(realRunner.isAlive(pid));
  await sleep(200);
  realRunner.kill(pid);
  await sleep(200);
  assert.equal(realRunner.isAlive(pid), false);
  assert.match(fs.readFileSync(logFile, 'utf8'), /started/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('realRunner.run times out with grandchild', async () => {
  const t0 = Date.now();
  const r = await realRunner.run('sh', ['-c', 'sleep 7.31 & wait'], { timeoutMs: 100 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - t0 < 1000);
  await sleep(200);
  let found = '';
  try {
    found = execFileSync('pgrep', ['-f', 'sleep 7.31'], { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when nothing matches
  }
  assert.equal(found.trim(), '');
});

test('realRunner.startTime identifies a live process and is stable', () => {
  const a = realRunner.startTime(process.pid);
  assert.ok(a && a.length > 0);
  assert.equal(realRunner.startTime(process.pid), a);
  assert.equal(realRunner.startTime(999_999), undefined);
  assert.equal(procAlive(realRunner, process.pid, a), true);
  assert.equal(procAlive(realRunner, process.pid, 'some other start'), false);
  assert.equal(procAlive(realRunner, 0), false);
});
