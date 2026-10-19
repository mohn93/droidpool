#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureDirs, loadConfig, type Config } from './config.ts';
import { realRunner, type Runner } from './exec.ts';
import { getDevice, listDevices, reap, releaseDevice } from './pool.ts';

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
          owner: { kind: 'mcp', pid },
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
    (args) => toResult(async () => (await releaseDevice(runner, cfg, args.serial)).message),
  );

  server.registerTool(
    'list_devices',
    { description: 'List all devices in the pool with their owners and state.' },
    () => toResult(() => JSON.stringify(listDevices(cfg))),
  );

  return server;
}

/** Releases every lease owned by this MCP process; errors are logged and skipped. */
export async function shutdown(deps: McpDeps): Promise<void> {
  const { runner, cfg, pid } = deps;
  const mine = listDevices(cfg).filter((d) => d.owner.kind === 'mcp' && d.owner.pid === pid);
  for (const d of mine) {
    try {
      await releaseDevice(runner, cfg, d.serial);
    } catch (e) {
      process.stderr.write(`droidpool-mcp: release ${d.serial} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }
}

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
    shutdown(deps)
      .catch((e) => process.stderr.write(`droidpool-mcp: shutdown failed: ${e instanceof Error ? e.message : e}\n`))
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
