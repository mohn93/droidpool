import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneDir, requiredFreeBytes, assertDiskOk, freeBytes } from '../src/disk.ts';
import { realRunner } from '../src/exec.ts';
import type { Runner } from '../src/exec.ts';
import { loadConfig } from '../src/config.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'droidpool-disk-'));
}

test('cloneDir clones a tree', async () => {
  const root = tmp();
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'a'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a', 'b.txt'), 'hello');
    const dest = path.join(root, 'dest');
    await cloneDir(realRunner, src, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'a', 'b.txt'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone failure leaves nothing', async () => {
  const root = tmp();
  try {
    const dest = path.join(root, 'dest');
    const runner = {
      async run() {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'partial'), 'x');
        return { code: 1, stdout: '', stderr: 'cp: clonefile failed' };
      },
    } as unknown as Runner;
    await assert.rejects(cloneDir(runner, path.join(root, 'src'), dest), /APFS required/);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requiredFreeBytes', () => {
  const cfg = loadConfig({});
  assert.equal(requiredFreeBytes(cfg), Math.ceil(1.2 * 6 * 2 ** 30) + 2 * 2 ** 30);
});

test('assertDiskOk throws below requirement', () => {
  const cfg = loadConfig({});
  assert.throws(() => assertDiskOk(cfg, 4 * 2 ** 30), /not enough disk: 4.0 GB free, need 9.2 GB/);
  assert.doesNotThrow(() => assertDiskOk(cfg, 100 * 2 ** 30));
});

test('freeBytes returns a positive number', () => {
  assert.ok(freeBytes(os.tmpdir()) > 0);
});
