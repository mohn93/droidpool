import fs from 'node:fs';
import path from 'node:path';

export type Flavor = 'clean' | 'signed-in';

export interface BaseRecord {
  name: string;
  flavor: Flavor;
  api: number;
  image: string;
  emulatorVersion: string;
  ramMb: number;
  builtAt: string;
}

export type Owner =
  | { kind: 'mcp'; pid: number; goneSince?: number }
  | { kind: 'cli'; expiresAt: number };

export interface Lease {
  deviceId: string;
  serial: string;
  port: number;
  emulatorPid: number;
  flavor: Flavor;
  api: number;
  project: string;
  owner: Owner;
  createdAt: number;
  state: 'booting' | 'ready';
}

export interface State {
  bases: BaseRecord[];
  leases: Lease[];
}

const RETRY_MS = 25;
const STALE_MS = 30_000;

function emptyState(): State {
  return { bases: [], leases: [] };
}

export function readState(stateFile: string): State {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<State>;
  return { bases: parsed.bases ?? [], leases: parsed.leases ?? [] };
}

function writeStateAtomic(stateFile: string, s: State): void {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function lockIsStale(lockDir: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return false; // vanished; the next mkdir attempt decides
  }
  if (ageMs > STALE_MS) return true;
  const pid = readOwner(lockDir);
  // No readable owner yet means the holder is between mkdir and writing it; age check covers a crash there.
  return pid !== undefined && !pidAlive(pid);
}

function breakLock(lockDir: string): void {
  // Rename first so only one breaker wins; then delete the renamed directory.
  const grave = `${lockDir}.${process.pid}.${Date.now()}.stale`;
  try {
    fs.renameSync(lockDir, grave);
  } catch {
    return;
  }
  fs.rmSync(grave, { recursive: true, force: true });
}

async function acquire(lockDir: string): Promise<void> {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid));
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lockIsStale(lockDir)) {
      breakLock(lockDir);
      continue;
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

export async function withState<T>(
  stateFile: string,
  fn: (s: State) => T | Promise<T>,
): Promise<T> {
  const lockDir = `${stateFile}.lock`;
  await acquire(lockDir);
  try {
    const s = readState(stateFile);
    const result = await fn(s);
    writeStateAtomic(stateFile, s);
    return result;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
