#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ensureDirs, loadConfig, type Config } from './config.ts';
import { realRunner, type Runner } from './exec.ts';
import { abortCurrentBuild, buildBase, currentBuildPid, listBases, removeBase } from './base.ts';
import { getDevice, listDevices, releaseDevice, renewLease, reap } from './pool.ts';
import { doctorReport } from './doctor.ts';
import type { Flavor } from './state.ts';

export interface CliDeps {
  runner: Runner;
  cfg: Config;
  out: (s: string) => void;
  err: (s: string) => void;
  waitForUser: (p: string) => Promise<void>;
}

const USAGE = `usage: droidpool <command> ...
  base build <clean|signed-in> [--api N]
  base list
  base rm <name>
  get [--clean|--signed-in] [--api N] [--project P]
  release <serial>
  renew <serial>
  ls
  gc
  doctor
`;

class UsageError extends Error {}

function parseApi(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`invalid --api: ${v}`);
  return Number(v);
}

function parseFlavor(v: string | undefined): Flavor {
  if (v === 'clean' || v === 'signed-in') return v;
  throw new UsageError('flavor must be clean or signed-in');
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n') + '\n';
}

async function dispatch(argv: string[], deps: CliDeps, reaped: string[]): Promise<void> {
  const { runner, cfg, out, err } = deps;
  const [cmd, ...rest] = argv;
  const opts = { strict: true, allowPositionals: true } as const;
  switch (cmd) {
    case 'base': {
      const [sub, ...args] = rest;
      if (sub === 'build') {
        const { values, positionals } = parseArgs({ ...opts, args, options: { api: { type: 'string' } } });
        if (positionals.length !== 1) throw new UsageError('base build needs a flavor');
        const flavor = parseFlavor(positionals[0]);
        const rec = await buildBase(runner, cfg, flavor, parseApi(values.api) ?? 35, {
          waitForUser: deps.waitForUser,
          log: (m) => err(m + '\n'),
        });
        out(`built ${rec.name}\n`);
      } else if (sub === 'list') {
        parseArgs({ ...opts, args, allowPositionals: false });
        const bases = listBases(cfg);
        if (bases.length > 0) {
          out(table([['NAME', 'FLAVOR', 'API', 'EMULATOR', 'BUILT'], ...bases.map((b) => [b.name, b.flavor, String(b.api), b.emulatorVersion, b.builtAt])]));
        }
      } else if (sub === 'rm') {
        const { positionals } = parseArgs({ ...opts, args });
        if (positionals.length !== 1) throw new UsageError('base rm needs a name');
        await removeBase(runner, cfg, positionals[0]!);
        out(`removed ${positionals[0]}\n`);
      } else {
        throw new UsageError(`unknown base command: ${sub ?? ''}`);
      }
      return;
    }
    case 'get': {
      const { values } = parseArgs({
        ...opts,
        args: rest,
        allowPositionals: false,
        options: {
          clean: { type: 'boolean' },
          'signed-in': { type: 'boolean' },
          api: { type: 'string' },
          project: { type: 'string' },
        },
      });
      if (values.clean && values['signed-in']) throw new UsageError('--clean and --signed-in are exclusive');
      const info = await getDevice(runner, cfg, {
        flavor: values['signed-in'] ? 'signed-in' : 'clean',
        api: parseApi(values.api),
        project: values.project ?? process.cwd(),
        owner: { kind: 'cli', expiresAt: Date.now() + cfg.cliTtlMs },
      });
      out(info.serial + '\n');
      return;
    }
    case 'release': {
      const { positionals } = parseArgs({ ...opts, args: rest });
      if (positionals.length !== 1) throw new UsageError('release needs a serial');
      const r = await releaseDevice(runner, cfg, positionals[0]!);
      if (!r.released) throw new Error(r.message);
      out(r.message + '\n');
      return;
    }
    case 'renew': {
      const { positionals } = parseArgs({ ...opts, args: rest });
      if (positionals.length !== 1) throw new UsageError('renew needs a serial');
      const info = await renewLease(cfg, positionals[0]!);
      out(`renewed ${info.serial}\n`);
      return;
    }
    case 'ls': {
      parseArgs({ ...opts, args: rest, allowPositionals: false });
      const rows = listDevices(cfg).map((d) => [
        d.serial, d.deviceId, d.flavor, String(d.api), d.project,
        d.owner.kind === 'cli' ? 'cli' : `mcp:${d.owner.pid}`, d.state,
      ]);
      out(table([['SERIAL', 'ID', 'FLAVOR', 'API', 'PROJECT', 'OWNER', 'STATE'], ...rows]));
      return;
    }
    case 'gc': {
      parseArgs({ ...opts, args: rest, allowPositionals: false });
      if (reaped.length > 0) out(reaped.join('\n') + '\n');
      return;
    }
    case 'doctor': {
      parseArgs({ ...opts, args: rest, allowPositionals: false });
      out(await doctorReport(runner, cfg));
      return;
    }
    default:
      throw new UsageError(`unknown command: ${cmd ?? ''}`);
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    ensureDirs(deps.cfg);
    let reaped: string[] = [];
    try {
      reaped = await reap(deps.runner, deps.cfg);
    } catch (e) {
      // A broken reap must not lock the user out of release, ls or doctor.
      deps.err(`droidpool: reap failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    await dispatch(argv, deps, reaped);
    return 0;
  } catch (e) {
    const isUsage = e instanceof UsageError || (e instanceof TypeError && String((e as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS'));
    if (isUsage) {
      deps.err(`droidpool: ${(e as Error).message}\n${USAGE}`);
      return 2;
    }
    deps.err(`droidpool: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function realWaitForUser(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write(prompt + '\n');
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
    rl.once('close', resolve);
  });
}

function isMain(): boolean {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(a)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const cfg = loadConfig();
  process.on('SIGINT', () => {
    process.stderr.write('droidpool: interrupted\n');
    // A base build's emulator is detached, so it would outlive us without this.
    if (currentBuildPid() !== undefined) abortCurrentBuild(realRunner, cfg);
    process.exit(130);
  });
  const code = await runCli(process.argv.slice(2), {
    runner: realRunner,
    cfg,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    waitForUser: realWaitForUser,
  });
  process.exitCode = code;
}
