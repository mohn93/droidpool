import fs from 'node:fs';
import type { Runner } from './exec.ts';
import type { Config } from './config.ts';

const GB = 2 ** 30;

/** APFS clonefile copy. Never falls back to a full copy. */
export async function cloneDir(runner: Runner, src: string, dest: string): Promise<void> {
  const r = await runner.run('cp', ['-c', '-R', src, dest]);
  if (r.code !== 0) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`clone failed (APFS required): ${r.stderr.trim()}`);
  }
}

export function freeBytes(path: string): number {
  const s = fs.statfsSync(path);
  return s.bavail * s.bsize;
}

export function requiredFreeBytes(cfg: Config): number {
  return Math.ceil(1.2 * cfg.dataPartitionBytes) + cfg.diskMarginBytes;
}

export function assertDiskOk(cfg: Config, free: number = freeBytes(cfg.home)): void {
  const need = requiredFreeBytes(cfg);
  if (free < need) {
    throw new Error(
      `not enough disk: ${(free / GB).toFixed(1)} GB free, need ${(need / GB).toFixed(1)} GB`,
    );
  }
}
