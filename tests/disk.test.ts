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
    fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(64 * 2 ** 20, 1));
    const dest = path.join(root, 'dest');
    const before = freeBytes(root);
    await cloneDir(realRunner, src, dest);
    const after = freeBytes(root);
    assert.equal(fs.readFileSync(path.join(dest, 'a', 'b.txt'), 'utf8'), 'hello');
    assert.ok(before - after < 8 * 2 ** 20, `clone used ${before - after} bytes`);
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
    const probe = { dev: () => 1, fsType: () => 26 };
    await assert.rejects(cloneDir(runner, path.join(root, 'src'), dest, probe), /APFS required/);
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

function countingRunner(): { runner: Runner; calls: number } {
  const state = { calls: 0 };
  const runner = {
    async run() {
      state.calls++;
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as Runner;
  return Object.assign(state, { runner }) as { runner: Runner; calls: number };
}

test('clone refuses cross-volume without running cp', async () => {
  const root = tmp();
  try {
    const c = countingRunner();
    const probe = { dev: (p: string) => (p.endsWith('src') ? 1 : 2), fsType: () => 26 };
    await assert.rejects(
      cloneDir(c.runner, path.join(root, 'src'), path.join(root, 'dest'), probe),
      /different volumes/,
    );
    assert.equal(c.calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone refuses non-APFS without running cp', async () => {
  const root = tmp();
  try {
    const c = countingRunner();
    const probe = { dev: () => 1, fsType: () => 17 };
    await assert.rejects(
      cloneDir(c.runner, path.join(root, 'src'), path.join(root, 'dest'), probe),
      /not APFS/,
    );
    assert.equal(c.calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone refuses existing dest', async () => {
  const root = tmp();
  try {
    const c = countingRunner();
    const dest = path.join(root, 'dest');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'keep'), 'k');
    const probe = { dev: () => 1, fsType: () => 26 };
    await assert.rejects(cloneDir(c.runner, path.join(root, 'src'), dest, probe), /already exists/);
    assert.equal(c.calls, 0);
    assert.equal(fs.readFileSync(path.join(dest, 'keep'), 'utf8'), 'k');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
