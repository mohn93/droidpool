import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDirs } from '../src/config.ts';

test('loadConfig defaults', () => {
  const c = loadConfig({ HOME: '/h' });
  assert.equal(c.home, '/h/.droidpool');
  assert.equal(c.avdHome, '/h/.droidpool/avd');
  assert.equal(c.logsDir, '/h/.droidpool/logs');
  assert.equal(c.stateFile, '/h/.droidpool/state.json');
  assert.equal(c.sdkRoot, '/h/Library/Android/sdk');
  assert.equal(c.emulatorBin, '/h/Library/Android/sdk/emulator/emulator');
  assert.equal(c.maxDevices, 3);
  assert.equal(c.ownerGraceMs, 120000);
  assert.equal(c.cliTtlMs, 7200000);
  assert.equal(c.queueWaitMs, 90000);
  assert.equal(c.bootTimeoutMs, 180000);
  assert.equal(c.killWaitMs, 15000);
  assert.equal(c.portMin, 5620);
  assert.equal(c.portMax, 5680);
  assert.equal(c.dataPartitionBytes, 6 * 2 ** 30);
  assert.equal(c.diskMarginBytes, 2 * 2 ** 30);
  assert.deepEqual(c.supportedApis, [35]);
});

test('loadConfig overrides', () => {
  assert.equal(loadConfig({ HOME: '/h', DROIDPOOL_HOME: '/x' }).home, '/x');
  assert.equal(loadConfig({ HOME: '/h', ANDROID_SDK_ROOT: '/s' }).sdkRoot, '/s');
  assert.equal(loadConfig({ HOME: '/h', ANDROID_HOME: '/a' }).sdkRoot, '/a');
  assert.equal(loadConfig({ HOME: '/h', ANDROID_SDK_ROOT: '/s', ANDROID_HOME: '/a' }).sdkRoot, '/s');
});

test('ensureDirs creates dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const c = loadConfig({ HOME: tmp });
  ensureDirs(c);
  for (const d of [c.home, c.avdHome, c.logsDir]) assert.ok(fs.statSync(d).isDirectory());
  fs.rmSync(tmp, { recursive: true, force: true });
});
