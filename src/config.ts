import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  home: string;
  avdHome: string;
  logsDir: string;
  stateFile: string;
  sdkRoot: string;
  emulatorBin: string;
  adbBin: string;
  sdkmanagerBin: string;
  avdmanagerBin: string;
  maxDevices: number;
  dataPartitionBytes: number;
  diskMarginBytes: number;
  ownerGraceMs: number;
  cliTtlMs: number;
  queueWaitMs: number;
  bootTimeoutMs: number;
  killWaitMs: number;
  portMin: number;
  portMax: number;
  supportedApis: number[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const userHome = env.HOME ?? os.homedir();
  const home = env.DROIDPOOL_HOME ?? path.join(userHome, '.droidpool');
  const sdkRoot =
    env.ANDROID_SDK_ROOT ?? env.ANDROID_HOME ?? path.join(userHome, 'Library', 'Android', 'sdk');
  return {
    home,
    avdHome: path.join(home, 'avd'),
    logsDir: path.join(home, 'logs'),
    stateFile: path.join(home, 'state.json'),
    sdkRoot,
    emulatorBin: path.join(sdkRoot, 'emulator', 'emulator'),
    adbBin: path.join(sdkRoot, 'platform-tools', 'adb'),
    sdkmanagerBin: path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    avdmanagerBin: path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
    maxDevices: 3,
    dataPartitionBytes: 6 * 2 ** 30,
    diskMarginBytes: 2 * 2 ** 30,
    ownerGraceMs: 120_000,
    cliTtlMs: 7_200_000,
    queueWaitMs: 90_000,
    bootTimeoutMs: 180_000,
    killWaitMs: 15_000,
    portMin: 5620,
    portMax: 5680,
    supportedApis: [35],
  };
}

export function ensureDirs(cfg: Config): void {
  for (const d of [cfg.home, cfg.avdHome, cfg.logsDir]) fs.mkdirSync(d, { recursive: true });
}
