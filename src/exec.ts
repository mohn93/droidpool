import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string },
  ): Promise<RunResult>;
  spawnDetached(
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; logFile: string },
  ): number;
  isAlive(pid: number): boolean;
  /** The process start time as `ps` reports it, or undefined when there is no such process. */
  startTime(pid: number): string | undefined;
  /** With group, signals the whole process group led by pid (detached children lead their own). */
  kill(pid: number, signal?: NodeJS.Signals, opts?: { group?: boolean }): void;
}

/**
 * True when pid is alive and, if a start time was recorded with it, is still the same process.
 * Pids are reused, so a pid alone can name an unrelated process hours later.
 */
export function procAlive(runner: Runner, pid: number, start?: string): boolean {
  if (pid <= 0 || !runner.isAlive(pid)) return false;
  return start === undefined || runner.startTime(pid) === start;
}

/**
 * Getters and base builders are always processes on this machine, so they are checked with the
 * real process table even when a test runner stands in for the emulator side.
 */
export function localProcAlive(p: { pid: number; start?: string }): boolean {
  return procAlive(realRunner, p.pid, p.start);
}

/** Process groups of run() children still running, so a signal handler can stop them. */
const liveRunGroups = new Set<number>();

/** Synchronous best effort for signal handlers: SIGKILL every run() child still running. */
export function killRunChildren(): void {
  for (const pid of liveRunGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  liveRunGroups.clear();
}

export const realRunner: Runner = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const done = (r: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.pid !== undefined) liveRunGroups.delete(child.pid);
        resolve(r);
      };
      const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: 'pipe', detached: true });
      if (child.pid !== undefined) liveRunGroups.add(child.pid);
      const timer =
        opts.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              try {
                if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
              done({ code: 124, stdout, stderr });
            }, opts.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.on('error', (e) => done({ code: 127, stdout, stderr: stderr + String(e.message) }));
      child.on('close', (code) => done({ code: timedOut ? 124 : (code ?? 1), stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ?? '');
    });
  },

  spawnDetached(cmd, args, opts) {
    const fd = fs.openSync(opts.logFile, 'a');
    try {
      const child = spawn(cmd, args, {
        env: opts.env ?? process.env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.on('error', () => {});
      child.unref();
      if (child.pid === undefined) throw new Error(`failed to spawn ${cmd}`);
      return child.pid;
    } finally {
      fs.closeSync(fd);
    }
  },

  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },

  startTime(pid) {
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  },

  kill(pid, signal = 'SIGTERM', opts = {}) {
    if (opts.group) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // not a group leader, or already gone: fall back to the pid
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  },
};
