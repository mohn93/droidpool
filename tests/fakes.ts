import type { Runner, RunResult } from '../src/exec.ts';

export interface FakeCall {
  kind: 'run' | 'spawn';
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
  logFile?: string;
}

type Matcher = (cmd: string, args: string[]) => boolean;
type Scripted = RunResult | ((cmd: string, args: string[]) => RunResult);

export class FakeRunner implements Runner {
  calls: FakeCall[] = [];
  alive = new Set<number>();
  killed: { pid: number; signal?: NodeJS.Signals }[] = [];
  private scripts: { match: Matcher; result: Scripted }[] = [];
  private nextPid = 1000;
  private pidQueue: number[] = [];

  /** Later registrations win over earlier ones. */
  onRun(match: Matcher, result: Scripted): this {
    this.scripts.push({ match, result });
    return this;
  }

  /**
   * Queues pids handed out by successive spawnDetached calls and marks them alive.
   * Once the queue is drained, the last pid keeps being returned.
   */
  onSpawn(...pids: number[]): this {
    if (pids.length === 0) throw new Error('onSpawn needs at least one pid');
    for (const p of pids) this.alive.add(p);
    this.pidQueue = pids.slice();
    this.nextPid = pids[pids.length - 1]!;
    return this;
  }

  async run(
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
  ): Promise<RunResult> {
    this.calls.push({ kind: 'run', cmd, args, env: opts.env, input: opts.input });
    for (let i = this.scripts.length - 1; i >= 0; i--) {
      const s = this.scripts[i]!;
      if (s.match(cmd, args)) return typeof s.result === 'function' ? s.result(cmd, args) : s.result;
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  spawnDetached(
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; logFile: string },
  ): number {
    this.calls.push({ kind: 'spawn', cmd, args, env: opts.env, logFile: opts.logFile });
    const pid = this.pidQueue.shift() ?? this.nextPid;
    this.alive.add(pid);
    return pid;
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  kill(pid: number, signal?: NodeJS.Signals): void {
    this.killed.push({ pid, signal });
    this.alive.delete(pid);
  }
}

/** Swallows process.stderr writes until restore(); text() returns what was written. */
export function captureStderr(): { text: () => string; restore: () => void } {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => buf,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}
