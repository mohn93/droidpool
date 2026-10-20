#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureDirs, loadConfig, type Config } from './config.ts';
import { killRunChildren, realRunner, type Runner } from './exec.ts';
import { abortCurrentGets, getDevice, listDevices, reap, releaseDevice } from './pool.ts';
import { withState } from './state.ts';
import { showDevice } from './viewer.ts';

export interface McpDeps {
  runner: Runner;
  cfg: Config;
  pid: number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function toResult(fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export function createServer(deps: McpDeps): McpServer {
  const { runner, cfg, pid } = deps;
  const start = runner.startTime(pid);
  const server = new McpServer({ name: 'droidpool', version: '0.1.0' });

  server.registerTool(
    'get_device',
    {
      description:
        'Get your own Android emulator device. Returns an adb serial; always use adb -s <serial>. Release it with release_device when done.',
      inputSchema: {
        flavor: z
          .enum(['clean', 'signed-in'])
          .optional()
          .describe('clean (default) or signed-in (Google account, Play Store)'),
        api: z.number().int().optional().describe('35'),
        project: z.string().describe('absolute path of the project you are testing'),
        reuse_serial: z.string().optional().describe('a serial you held before a reconnect'),
      },
    },
    (args) =>
      toResult(async () => {
        const d = await getDevice(runner, cfg, {
          flavor: args.flavor ?? 'clean',
          api: args.api,
          project: args.project,
          owner: { kind: 'mcp', pid, ...(start !== undefined && { start }) },
          reuseSerial: args.reuse_serial,
        });
        return JSON.stringify({ serial: d.serial, deviceId: d.deviceId, flavor: d.flavor, api: d.api });
      }),
  );

  server.registerTool(
    'release_device',
    {
      description: 'Release a device you got from get_device.',
      inputSchema: { serial: z.string().describe('serial returned by get_device') },
    },
    (args) =>
      toResult(async () => {
        const r = await releaseDevice(runner, cfg, args.serial, { requireOwnerPid: pid });
        if (!r.released) throw new Error(r.message);
        return r.message;
      }),
  );

  server.registerTool(
    'show_device',
    {
      description:
        'Open a window on the user\'s screen mirroring a device (scrcpy), so the user can watch or interact, for example to log in by hand. Devices are headless otherwise. The window closes when the device is released.',
      inputSchema: { serial: z.string().describe('serial returned by get_device') },
    },
    (args) => toResult(() => showDevice(runner, cfg, args.serial, { requireOwnerPid: pid })),
  );

  server.registerTool(
    'list_devices',
    { description: 'List all devices in the pool with their owners and state.' },
    () => toResult(() => JSON.stringify(listDevices(cfg))),
  );

  return server;
}

/**
 * On a clean exit, devices are kept for the owner grace period so a reconnecting session can
 * reclaim them with reuse_serial. Marks every lease owned by this process as gone now, so the
 * grace clock starts at exit rather than at the next reap. Returns how many were marked.
 */
export async function markGone(deps: McpDeps): Promise<number> {
  const { cfg, pid } = deps;
  const now = Date.now();
  return withState(cfg.stateFile, (s) => {
    let n = 0;
    for (const l of s.leases) {
      if (l.owner.kind === 'mcp' && l.owner.pid === pid) {
        l.owner.goneSince = now;
        l.owner.exited = true;
        n++;
      }
    }
    return n;
  });
}

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));
const shq = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/**
 * Spawns a detached `droidpool gc` that runs just after the owner grace period, so devices
 * left by an exited session are reaped even if no other droidpool command runs.
 */
export function scheduleReaper(runner: Runner, cfg: Config): void {
  const sleepS = Math.ceil(cfg.ownerGraceMs / 1000) + 5;
  const script = `sleep ${sleepS}; exec ${shq(process.execPath)} --disable-warning=ExperimentalWarning ${shq(CLI_PATH)} gc`;
  const logFile = path.join(cfg.logsDir, 'reaper.log');
  // Appended to on every exit; start over once it gets large.
  try {
    if (fs.statSync(logFile).size > REAPER_LOG_MAX) fs.truncateSync(logFile, 0);
  } catch {
    // no log yet
  }
  runner.spawnDetached('sh', ['-c', script], { env: process.env, logFile });
}

const REAPER_LOG_MAX = 1024 * 1024;

const REAP_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDirs(cfg);
  const deps: McpDeps = { runner: realRunner, cfg, pid: process.pid };
  const server = createServer(deps);

  const timer = setInterval(() => {
    reap(realRunner, cfg).catch((e) => {
      process.stderr.write(`droidpool-mcp: reap failed: ${e instanceof Error ? e.message : e}\n`);
    });
  }, REAP_INTERVAL_MS);
  timer.unref();

  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    // A get_device still booting would leave its emulator behind; its booting lease is reaped
    // once the reaper sees this process is gone.
    killRunChildren();
    abortCurrentGets(realRunner, cfg);
    markGone(deps)
      .then((n) => {
        if (n > 0) scheduleReaper(realRunner, cfg);
      })
      .catch((e) => process.stderr.write(`droidpool-mcp: exit cleanup failed: ${e instanceof Error ? e.message : e}\n`))
      .finally(() => process.exit(0));
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await server.connect(new StdioServerTransport());
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
  await main();
}
