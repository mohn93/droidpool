import type { Config } from './config.ts';

export function pickPort(cfg: Config, used: Set<number>): number | null {
  const start = cfg.portMin % 2 === 0 ? cfg.portMin : cfg.portMin + 1;
  for (let p = start; p <= cfg.portMax; p += 2) {
    if (!used.has(p)) return p;
  }
  return null;
}
