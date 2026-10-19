import type { Runner, RunResult } from '../src/exec.ts';

export interface FakeCall {
  kind: 'run' | 'spawn';
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  logFile?: string;
}

type Matcher = (cmd: string, args: string[]) => boolean;
type Scripted = RunResult | (() => RunResult);

export class FakeRunner implements Runner {
  calls: FakeCall[] = [];
  alive = new Set<number>();
  killed: { pid: number; signal?: NodeJS.Signals }[] = [];
  private scripts: { match: Matcher; result: Scripted }[] = [];
  private nextPid = 1000;

  /** Later registrations win over earlier ones. */
  onRun(match: Matcher, result: Scripted): this {
    this.scripts.push({ match, result });
    return this;
  }

  /** Sets the pid returned by the next spawnDetached and marks it alive. */
  onSpawn(pid: number): this {
    this.nextPid = pid;
    this.alive.add(pid);
    return this;
  }

  async run(
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
  ): Promise<RunResult> {
    this.calls.push({ kind: 'run', cmd, args, env: opts.env });
    for (let i = this.scripts.length - 1; i >= 0; i--) {
      const s = this.scripts[i]!;
      if (s.match(cmd, args)) return typeof s.result === 'function' ? s.result() : s.result;
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  spawnDetached(
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; logFile: string },
  ): number {
    this.calls.push({ kind: 'spawn', cmd, args, env: opts.env, logFile: opts.logFile });
    const pid = this.nextPid;
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
