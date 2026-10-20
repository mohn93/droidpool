import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './exec.ts';
import type { Config } from './config.ts';

const GB = 2 ** 30;

const APFS_FSTYPE = 26;

export interface CloneProbe {
  dev(path: string): number;
  fsType(path: string): number;
}

const realProbe: CloneProbe = {
  dev: (p) => fs.statSync(p).dev,
  fsType: (p) => fs.statfsSync(p).type,
};

/**
 * APFS clonefile copy. `cp -c` silently falls back to a full copy when cloning is
 * impossible, so we refuse up front unless a clone is guaranteed.
 */
export async function cloneDir(
  runner: Runner,
  src: string,
  dest: string,
  probe: CloneProbe = realProbe,
): Promise<void> {
  const fail = (reason: string) => new Error(`clone failed (APFS required): ${reason}`);
  if (fs.existsSync(dest)) throw fail('dest already exists');
  const destParent = path.dirname(dest);
  if (probe.dev(src) !== probe.dev(destParent)) throw fail('src and dest on different volumes');
  if (probe.fsType(destParent) !== APFS_FSTYPE) throw fail('dest filesystem is not APFS');
  let r;
  try {
    r = await runner.run('cp', ['-c', '-R', src, dest]);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  if (r.code !== 0) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw fail(r.stderr.trim());
  }
}

export function freeBytes(p: string): number {
  const s = fs.statfsSync(p);
  return s.bavail * s.bsize;
}

/** Room one device's clone may grow into: its data partition plus slack. */
export function perDeviceBytes(cfg: Config): number {
  return Math.ceil(1.2 * cfg.dataPartitionBytes);
}

/**
 * Free space needed to add one device while `live` devices run. Clones start near zero bytes
 * but each may grow to its data partition, so live devices keep their share reserved.
 */
export function requiredFreeBytes(cfg: Config, live = 0): number {
  return perDeviceBytes(cfg) * (live + 1) + cfg.diskMarginBytes;
}

export function assertDiskOk(cfg: Config, free: number = freeBytes(cfg.home), live = 0): void {
  const need = requiredFreeBytes(cfg, live);
  if (free < need) {
    const with_ = live > 0 ? ` with ${live} device${live === 1 ? '' : 's'} running` : '';
    throw new Error(
      `not enough disk: ${(free / GB).toFixed(1)} GB free, need ${(need / GB).toFixed(1)} GB${with_}`,
    );
  }
}
