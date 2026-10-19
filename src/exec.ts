import { spawn } from 'node:child_process';
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
  kill(pid: number, signal?: NodeJS.Signals): void;
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
        resolve(r);
      };
      const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: 'pipe' });
      const timer =
        opts.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
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

  kill(pid, signal = 'SIGTERM') {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  },
};
