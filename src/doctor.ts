import path from 'node:path';
import type { Runner } from './exec.ts';
import type { Config } from './config.ts';
import { emulatorVersion } from './emulator.ts';
import { listBases } from './base.ts';
import { listDevices } from './pool.ts';
import { requiredFreeBytes } from './disk.ts';

const gb = (n: number) => (n / 2 ** 30).toFixed(1);

export async function doctorReport(runner: Runner, cfg: Config): Promise<string> {
  const bases = listBases(cfg);
  const lines: string[] = [];
  let current: string | undefined;
  try {
    current = await emulatorVersion(runner, cfg);
    lines.push(`emulator: ${current}`);
  } catch (e) {
    lines.push(`emulator: unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
  lines.push(`bases: ${bases.length}`);
  lines.push(`devices: ${listDevices(cfg).length}`);
  lines.push(`free disk: ${gb(cfg.freeBytesFn(cfg.home))} GB (need ${gb(requiredFreeBytes(cfg))} GB per device)`);

  let size = '0';
  if (bases.length > 0) {
    const dirs = bases.map((b) => path.join(cfg.avdHome, `${b.name}.avd`));
    const r = await runner.run('du', ['-shc', ...dirs]);
    // With -c the last line is the total.
    const last = r.stdout.trim().split('\n').pop() ?? '';
    size = last.split(/\s+/)[0] || 'unknown';
  }
  lines.push(`bases on disk: ${size}`);

  if (current !== undefined) {
    for (const b of bases) {
      if (b.emulatorVersion !== current) {
        lines.push(`warning: base ${b.name} built on ${b.emulatorVersion}, emulator is ${current}; rebuild it`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
