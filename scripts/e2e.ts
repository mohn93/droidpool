#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Real-emulator smoke test. Does nothing unless DROIDPOOL_E2E=1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { realRunner } from '../src/exec.ts';
import { runCli } from '../src/cli.ts';
import { requiredFreeBytes } from '../src/disk.ts';

if (process.env.DROIDPOOL_E2E !== '1') process.exit(0);

const GiB = 2 ** 30;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'droidpool-e2e-'));
const cfg = loadConfig({ ...process.env, DROIDPOOL_HOME: home });

let outBuf = '';
const cli = async (...argv: string[]): Promise<string> => {
  outBuf = '';
  const code = await runCli(argv, {
    runner: realRunner,
    cfg,
    out: (s) => (outBuf += s),
    err: (s) => process.stderr.write(s),
    waitForUser: async () => {},
  });
  assert.equal(code, 0, `droidpool ${argv.join(' ')} exited ${code}`);
  return outBuf.trim();
};
const adb = (serial: string, ...args: string[]) =>
  realRunner.run(cfg.adbBin, ['-s', serial, ...args], { timeoutMs: 120_000 });

const need = requiredFreeBytes(cfg) + 6 * GiB;
const free = cfg.freeBytesFn(os.tmpdir());
if (free < need) {
  console.error(`e2e: not enough free disk: ${(free / GiB).toFixed(1)} GiB free, need ${(need / GiB).toFixed(1)} GiB`);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const serials: string[] = [];
try {
  await cli('base', 'build', 'clean');

  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const serial = await cli('get', '--clean');
    console.log(`boot ${serial} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    serials.push(serial);
  }
  assert.notEqual(serials[0], serials[1], 'serials must be distinct');

  for (const s of serials) {
    const r = await adb(s, 'shell', 'getprop', 'sys.boot_completed');
    assert.equal(r.stdout.trim(), '1', `${s} not booted`);
  }

  // Device ids come from `ls`: columns SERIAL ID ...
  for (const line of (await cli('ls')).split('\n').slice(1)) {
    const [serial, id] = line.split(/\s+/);
    if (serial && id && serials.includes(serial)) ids.push(id);
  }
  assert.equal(ids.length, 2, 'ls should list both devices');
  for (const [i, id] of ids.entries()) {
    const log = fs.readFileSync(path.join(cfg.logsDir, `${id}.log`), 'utf8');
    const loaded = log.includes('Successfully loaded snapshot');
    console.log(`snapshot loaded: ${serials[i]} ${loaded ? 'yes' : 'no'}`);
    assert.ok(loaded, `${id} did not load the snapshot (cold boot?)`);
  }

  const before = cfg.freeBytesFn(home);
  const dd = await adb(serials[0]!, 'shell', 'dd', 'if=/dev/zero', 'of=/data/local/tmp/blob', 'bs=1m', 'count=200');
  assert.equal(dd.code, 0, `dd failed: ${dd.stderr}`);
  for (const s of serials) await cli('release', s);
  const freedMb = Math.round((cfg.freeBytesFn(home) - before) / 2 ** 20);
  console.log(`freed ${freedMb} MB`);

  await cli('gc');
  const left = fs.readdirSync(cfg.avdHome).filter((n) => n.startsWith('dev-'));
  assert.deepEqual(left, [], 'dev-* dirs remain after gc');
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  for (const s of serials) {
    try {
      await cli('release', s);
    } catch {}
  }
  try {
    await cli('gc');
  } catch {}
  fs.rmSync(home, { recursive: true, force: true });
}
