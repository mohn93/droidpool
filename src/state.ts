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

/** A process by pid plus its start time, so a reused pid is not mistaken for it. */
export interface ProcRef {
  pid: number;
  start?: string;
}

export type Owner =
  | { kind: 'mcp'; pid: number; start?: string; goneSince?: number; exited?: true }
  | { kind: 'cli'; expiresAt: number };

export interface Lease {
  deviceId: string;
  serial: string;
  port: number;
  emulatorPid: number;
  emulatorStart?: string;
  flavor: Flavor;
  api: number;
  project: string;
  owner: Owner;
  createdAt: number;
  state: 'booting' | 'ready';
  /** pid of the scrcpy mirror window opened by `droidpool show`, if any. */
  viewerPid?: number;
  viewerStart?: string;
  /** The process running getDevice while the lease is booting; a dead getter means an abandoned boot. */
  getter?: ProcRef;
}

/** A base build in progress; getters refuse that base and a second build of it is refused. */
export interface BuildRecord extends ProcRef {
  name: string;
  startedAt: number;
}

export interface State {
  bases: BaseRecord[];
  leases: Lease[];
  builds: BuildRecord[];
}

const RETRY_MS = 25;
const STALE_MS = 30_000;

function emptyState(): State {
  return { bases: [], leases: [], builds: [] };
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
  return { bases: parsed.bases ?? [], leases: parsed.leases ?? [], builds: parsed.builds ?? [] };
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

const BREAK_STALE_MS = 5_000;

// Breaking is serialized by a second mkdir mutex so a slow breaker cannot
// rename away a lock that someone else acquired after the first break.
// Returns false when another breaker holds the mutex, so the caller should back off.
function breakLock(lockDir: string): boolean {
  const mutex = `${lockDir}.break`;
  try {
    fs.mkdirSync(mutex);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > BREAK_STALE_MS) {
        fs.rmSync(mutex, { recursive: true, force: true });
      }
    } catch {
      // vanished; caller retries
    }
    return false;
  }
  try {
    if (!lockIsStale(lockDir)) return true;
    const grave = `${lockDir}.${process.pid}.${Date.now()}.stale`;
    try {
      fs.renameSync(lockDir, grave);
    } catch {
      return true;
    }
    fs.rmSync(grave, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(mutex, { recursive: true, force: true });
  }
}

async function acquire(lockDir: string): Promise<number> {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid));
      return fs.statSync(lockDir).ino;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lockIsStale(lockDir) && breakLock(lockDir)) continue;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

function holdsLock(lockDir: string, ino: number): boolean {
  try {
    return fs.statSync(lockDir).ino === ino && readOwner(lockDir) === process.pid;
  } catch {
    return false;
  }
}

/** Do not nest withState calls, and keep fn well under 30 s (the lock is breakable after that). */
export async function withState<T>(
  stateFile: string,
  fn: (s: State) => T | Promise<T>,
): Promise<T> {
  const lockDir = `${stateFile}.lock`;
  const ino = await acquire(lockDir);
  let lost = false;
  try {
    const s = readState(stateFile);
    const result = await fn(s);
    if (!holdsLock(lockDir, ino)) {
      lost = true;
      throw new Error('state lock lost while held');
    }
    writeStateAtomic(stateFile, s);
    return result;
  } finally {
    if (!lost && holdsLock(lockDir, ino)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}
