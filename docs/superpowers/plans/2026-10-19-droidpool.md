# droidpool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI and MCP server that give each AI agent its own Android emulator. Each device is an APFS clone of a frozen, snapshotted base, so it costs about the disk it writes. Devices are deleted on release or when their owner disappears.

**Architecture:**
- **Bases:** stock-emulator AVDs under droidpool's own AVD home, booted once, snapshotted, then frozen.
- **Devices:** made by cloning a base with `cp -c -R`, rewriting the snapshot's `hardware.ini`, and launching with one fixed flag set.
- **Shared state:** a locked JSON file holds leases, so concurrent CLI and MCP processes stay consistent. A reaper removes orphans on every command.
- **Testing seam:** all OS interaction goes through a `Runner` interface, so the orchestration can be unit-tested with fakes. One gated end-to-end script exercises the real emulator.

**Tech Stack:**
- TypeScript run directly by Node 22 type stripping (no build step). `tsc --noEmit` for type checks.
- `node:test` for tests.
- `@modelcontextprotocol/sdk` 1.x and `zod` 3.x, both pinned exactly with `npm i -E`.
- Stock Android Emulator 36.5.11 from `~/Library/Android/sdk`.

**Spec:** `docs/superpowers/specs/2026-10-19-droidpool-design.md`

## Global Constraints
- Node >= 22.18. Source files are `.ts` with erasable syntax only: no `enum`, no `namespace`, no parameter properties. Imports use explicit `.ts` extensions.
- droidpool's AVD home is `~/.droidpool/avd` (overridable with `DROIDPOOL_HOME`). Every emulator, avdmanager and sdkmanager call sets `ANDROID_AVD_HOME` to it. `~/.android/avd` is never read or written.
- Device launch flags are exactly `-avd <id> -port <p> -no-snapshot-save -no-boot-anim -no-window`, and nothing else.
- Base AVD config:
  - `hw.ramSize=4096`, `vm.heapSize=512M`, `hw.cpu.ncore=6`, `hw.gpu.enabled=yes`, `hw.gpu.mode=host`
  - `disk.dataPartition.size=6G`, `fastboot.forceFastBoot=yes`, `showDeviceFrame=no`, `hw.audioInput=no`
  - device profile `pixel_7`
  - animation scales set to 0 before the snapshot
- Flavors and images:
  - `clean` uses `system-images;android-<api>;google_apis;arm64-v8a`.
  - `signed-in` uses `system-images;android-<api>;google_apis_playstore;arm64-v8a`.
  - v1 accepts `api` 35 only.
- Names: bases are `base-<flavor>-<api>` (for example `base-clean-35`). Devices are `dev-<6 lowercase hex>`. The serial is `emulator-<port>`, with ports even and in 5620-5680.
- Defaults (my calls, from the spec):
  - `maxDevices` 3
  - owner grace 120 s
  - CLI lease TTL 2 h
  - pool-full wait 90 s
  - boot timeout 180 s
  - free-disk requirement = 1.2 x 6 GiB + 2 GiB margin
- Cloning uses `cp -c -R` only. If that fails, abort. Never fall back to a full copy.
- `get` never builds a base. A missing base produces an error that names `droidpool base build <flavor> --api <api>`.
- A base whose recorded emulator version differs from the current `emulator -version` is refused, with: `base <name> was built on emulator <X>; emulator is now <Y>. Rebuild: droidpool base build <flavor> --api <api>`.
- Git: work on `dev`. Commit messages are short, imperative, and contain no emoji.

## Review Focus
1. The emulator process dies during boot, for example from a FATAL disk error. `get` fails with the first `FATAL` line from the device log, and the clone directory and the lease are both gone (Task 7 test `boot failure cleans up`).
2. Two `get` calls from separate processes at the same moment get different ports and device ids, and neither sees a corrupt state file (Task 3 test `concurrent writers serialize`, Task 7 test `parallel gets get distinct ports`).
3. Releasing an unknown or already-released serial succeeds as a no-op and says so. It does not throw (Task 7 test `release is idempotent`).
4. `cp -c` fails because the target is not on APFS. `get` errors with "clone failed (APFS required)" and leaves no partial directory (Task 4 test `clone failure leaves nothing`).
5. Boot hangs past 180 s with the process still alive. The emulator is killed, then cleanup happens as in item 1 (Task 7 test `boot timeout kills and cleans up`).

---

## File Structure
```
package.json, tsconfig.json, .gitignore, README.md
src/config.ts      Config type, loadConfig(env)
src/exec.ts        Runner interface + realRunner
src/avdfiles.ts    pure text: tuned config.ini, device .ini, hardware.ini rewrite
src/state.ts       locked JSON store of bases + leases
src/disk.ts        cloneDir, freeBytes, requiredFreeBytes, assertDiskOk
src/ports.ts       pickPort
src/emulator.ts    emulator/adb wrapper: version, launch, waitBoot, kill, setAnimationsOff, saveSnapshot
src/base.ts        buildBase, listBases, removeBase, assertBaseUsable
src/pool.ts        getDevice, releaseDevice, renewLease, listDevices, reap
src/doctor.ts      doctor report
src/cli.ts         CLI entry (bin: droidpool)
src/mcp.ts         MCP stdio server (bin: droidpool-mcp)
guidance/agents.md CLAUDE.md snippet for agents
tests/*.test.ts    unit tests; tests/fakes.ts shared fakes
scripts/e2e.ts     real-emulator smoke, gated by DROIDPOOL_E2E=1
```

---

### Task 1: Repo, config, and Runner

**Files:**
- Create: `.gitignore` (`node_modules/`), `package.json`, `tsconfig.json`, `src/config.ts`, `src/exec.ts`, `tests/config.test.ts`, `tests/exec.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { home; avdHome; logsDir; stateFile; sdkRoot; emulatorBin; adbBin; sdkmanagerBin; avdmanagerBin: string; maxDevices: number; dataPartitionBytes: number; diskMarginBytes: number; ownerGraceMs: number; cliTtlMs: number; queueWaitMs: number; bootTimeoutMs: number; portMin: number; portMax: number; supportedApis: number[] }`
  - `loadConfig(env?: NodeJS.ProcessEnv): Config`
  - `interface RunResult { code: number; stdout: string; stderr: string }`
  - `interface Runner { run(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<RunResult>; spawnDetached(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; logFile: string }): number; isAlive(pid: number): boolean; kill(pid: number, signal?: NodeJS.Signals): void }`
  - `realRunner: Runner`

- [ ] **Step 1: Init repo**
  Run:
  ```bash
  git init -b main && git add FINDINGS.md make-fast-avd.sh run-fast-avd.sh docs && git commit -m "Add emulator research and droidpool design" && git checkout -b dev
  ```
  Expected: on branch `dev`.
- [ ] **Step 2: Create `package.json`**
  - `"type": "module"`, `"private": true`, `"engines": { "node": ">=22.18" }`
  - `"bin": { "droidpool": "src/cli.ts", "droidpool-mcp": "src/mcp.ts" }`, with both files starting `#!/usr/bin/env node`
  - scripts: `"test": "node --test tests/*.test.ts"` and `"typecheck": "tsc --noEmit"`
- [ ] **Step 3: Create `tsconfig.json`** with `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`, `target` `es2023`. Then run `npm i -E -D typescript@5.8.3 @types/node@22`.
- [ ] **Step 4: Write failing tests**
  - `loadConfig defaults`: with `env = { HOME: '/h' }`:
    - `home === '/h/.droidpool'`, `avdHome === '/h/.droidpool/avd'`, `stateFile === '/h/.droidpool/state.json'`
    - `sdkRoot === '/h/Library/Android/sdk'`, `emulatorBin === '/h/Library/Android/sdk/emulator/emulator'`
    - `maxDevices === 3`, `ownerGraceMs === 120000`, `cliTtlMs === 7200000`, `queueWaitMs === 90000`, `bootTimeoutMs === 180000`
    - `portMin === 5620`, `portMax === 5680`
    - `dataPartitionBytes === 6 * 2**30`, `diskMarginBytes === 2 * 2**30`
    - `deepEqual(supportedApis, [35])`
  - `loadConfig overrides`: `DROIDPOOL_HOME=/x` gives `home === '/x'`. `ANDROID_SDK_ROOT=/s` gives `sdkRoot === '/s'`. `ANDROID_HOME` is used when `ANDROID_SDK_ROOT` is unset.
  - `realRunner.run captures output`: `run('sh', ['-c', 'echo hi; echo err >&2; exit 3'])` returns `{ code: 3, stdout: 'hi\n', stderr: 'err\n' }`.
  - `realRunner.run times out`: `run('sleep', ['5'], { timeoutMs: 100 })` resolves with `code !== 0` within 1 s.
  - `realRunner.spawnDetached writes log and isAlive`: spawn `sh -c 'echo started; sleep 2'` into a temp log. `isAlive(pid)` is true; after `kill(pid)` and 200 ms it is false; the log contains `started`.
- [ ] **Step 5: Run `npm test`.** Expected: FAIL (modules missing).
- [ ] **Step 6: Implement** `src/config.ts` and `src/exec.ts`.
  - `run` uses `child_process.spawn` and resolves on `close`.
  - `spawnDetached` uses `detached: true`, with stdio going to an `fs.openSync(logFile, 'a')` fd, then `unref()`.
  - `isAlive` uses `process.kill(pid, 0)` in a try/catch.
- [ ] **Step 7: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 8: Commit.** `git add .gitignore package.json package-lock.json tsconfig.json src tests && git commit -m "Add config and process runner"`

### Task 2: AVD file text functions

**Files:**
- Create: `src/avdfiles.ts`, `tests/avdfiles.test.ts`

**Interfaces:**
- Produces:
  - `TUNED_CONFIG: Record<string, string>` (the Global Constraints keys and values)
  - `applyConfig(configIni: string, values: Record<string, string>): string`. Replaces existing `key=` lines and appends missing ones, keeping all other lines.
  - `deviceIni(avdDir: string, api: number): string`
  - `rewriteHardwareIni(text: string, fromName: string, fromDir: string, toName: string, toDir: string): string`

- [ ] **Step 1: Write failing tests**
  - `applyConfig replaces and appends`: given `'a=1\nhw.ramSize=2048\n'` and `{ 'hw.ramSize': '4096', 'hw.cpu.ncore': '6' }`, the result contains `a=1`, `hw.ramSize=4096` and `hw.cpu.ncore=6`, and has exactly one `hw.ramSize` line.
  - `deviceIni`: `deviceIni('/h/.droidpool/avd/dev-abc123.avd', 35)` equals `'avd.ini.encoding=UTF-8\npath=/h/.droidpool/avd/dev-abc123.avd\ntarget=android-35\n'`.
  - `rewriteHardwareIni paths and ids`: input lines are copied from the spike:
    - `disk.dataPartition.path = /h/.droidpool/avd/../avd/base-clean-35.avd/userdata-qemu.img`
    - `disk.cachePartition.path = /h/.droidpool/avd/base-clean-35.avd/cache.img`
    - `avd.name = base-clean-35`
    - `avd.id = base-clean-35`
    - `hw.ramSize = 4096`

    With `fromDir='/h/.droidpool/avd/base-clean-35.avd'` and `toDir='/h/.droidpool/avd/dev-abc123.avd'`, the output:
    - has `disk.dataPartition.path = /h/.droidpool/avd/dev-abc123.avd/userdata-qemu.img`
    - has `disk.cachePartition.path = /h/.droidpool/avd/dev-abc123.avd/cache.img`
    - has `avd.name = dev-abc123` and `avd.id = dev-abc123`
    - keeps `hw.ramSize = 4096` unchanged
    - contains no `base-clean-35` anywhere
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/avdfiles.ts`. Path values match any path whose directory component is `<fromName>.avd`, including through a `/../avd/` segment. Replace everything up to and including that component with `toDir`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/avdfiles.ts tests/avdfiles.test.ts && git commit -m "Add AVD config and snapshot rewrite helpers"`

### Task 3: Locked state store

**Files:**
- Create: `src/state.ts`, `tests/state.test.ts`

**Interfaces:**
- Produces:
  - `type Flavor = 'clean' | 'signed-in'`
  - `interface BaseRecord { name: string; flavor: Flavor; api: number; image: string; emulatorVersion: string; ramMb: number; builtAt: string }`
  - `type Owner = { kind: 'mcp'; pid: number; goneSince?: number } | { kind: 'cli'; expiresAt: number }`
  - `interface Lease { deviceId: string; serial: string; port: number; emulatorPid: number; flavor: Flavor; api: number; project: string; owner: Owner; createdAt: number; state: 'booting' | 'ready' }`
  - `interface State { bases: BaseRecord[]; leases: Lease[] }`
  - `withState<T>(stateFile: string, fn: (s: State) => T | Promise<T>): Promise<T>`. Takes the lock, reads (an absent file reads as empty state), runs `fn` (which mutates `s`), writes atomically (temp file plus rename), and releases the lock.
  - `readState(stateFile: string): State` (no lock, read-only)

- [ ] **Step 1: Write failing tests**
  - `empty when missing`: `readState(tmp/state.json)` deep-equals `{ bases: [], leases: [] }`.
  - `withState persists mutation`: push a lease inside `withState`. Then `readState` shows 1 lease.
  - `concurrent writers serialize`: spawn 8 child Node processes (`node -e` importing `src/state.ts`), each doing 25 `withState` increments of a counter stored in a lease's `port`. Final `port === 200`, and the file parses as JSON.
  - `stale lock is broken`: create the lock directory with an `owner` file holding a dead pid (`999999`). `withState` completes within 2 s.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The lock is `fs.mkdirSync(stateFile + '.lock')`, with `owner` holding `process.pid`.
  - On `EEXIST`, retry every 25 ms. Break the lock if the owner pid is dead or the lock is older than 30 s.
  - Release in `finally`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/state.ts tests/state.test.ts && git commit -m "Add locked JSON state store"`

### Task 4: Disk guard, cloning, ports

**Files:**
- Create: `src/disk.ts`, `src/ports.ts`, `tests/disk.test.ts`, `tests/ports.test.ts`

**Interfaces:**
- Consumes: `Runner`, `Config`
- Produces:
  - `cloneDir(runner: Runner, src: string, dest: string): Promise<void>`. Throws `Error('clone failed (APFS required): <stderr>')`.
  - `freeBytes(path: string): number` (`fs.statfsSync`: `bavail * bsize`)
  - `requiredFreeBytes(cfg: Config): number` (`Math.ceil(1.2 * dataPartitionBytes) + diskMarginBytes`)
  - `assertDiskOk(cfg: Config, free?: number): void`. Throws `Error('not enough disk: <free GB> GB free, need <need GB> GB')`, with GB to 1 decimal.
  - `pickPort(cfg: Config, used: Set<number>): number | null`. Returns the lowest even port in `[portMin, portMax]` not in `used`, or `null`.

- [ ] **Step 1: Write failing tests**
  - `cloneDir clones a tree`: make `src/a/b.txt` in a temp dir. After `cloneDir(realRunner, src, dest)`, `dest/a/b.txt` has the same content.
  - `clone failure leaves nothing`: use a fake runner whose `run` returns `{ code: 1, stderr: 'cp: clonefile failed' }`. `cloneDir` rejects with a message containing `APFS required`, and `dest` does not exist. Pre-create a partial `dest` in the fake to prove it is removed.
  - `requiredFreeBytes`: with the default config it equals `Math.ceil(1.2 * 6 * 2**30) + 2 * 2**30`.
  - `assertDiskOk throws below requirement`: `assertDiskOk(cfg, 4 * 2**30)` throws `/not enough disk: 4.0 GB free, need 9.2 GB/`.
  - `pickPort`: `pickPort(cfg, new Set([5620, 5622]))` is `5624`. With every even port in range used, it is `null`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/disk.ts`, where `cloneDir` runs `cp -c -R src dest` and calls `fs.rmSync(dest, {recursive, force})` on failure, and `src/ports.ts`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/disk.ts src/ports.ts tests/disk.test.ts tests/ports.test.ts && git commit -m "Add disk guard, APFS clone, port picker"`

### Task 5: Emulator wrapper

**Files:**
- Create: `src/emulator.ts`, `tests/fakes.ts`, `tests/emulator.test.ts`

**Interfaces:**
- Consumes: `Runner`, `Config`
- Produces:
  - `emulatorVersion(runner: Runner, cfg: Config): Promise<string>`. Parses `Android emulator version 36.5.11.0 ...` into `'36.5.11'`.
  - `launchDevice(runner: Runner, cfg: Config, avdName: string, port: number, opts?: { window?: boolean; snapshotSave?: boolean }): number`. Returns the pid. The log goes to `<logsDir>/<avdName>.log`.
  - `waitBoot(runner: Runner, cfg: Config, serial: string, pid: number, logFile: string): Promise<void>`. Polls `adb -s <serial> shell getprop sys.boot_completed` every 500 ms. Throws `Error('emulator exited: <first FATAL line or "no FATAL line">')` if the pid dies, and `Error('boot timed out after 180s')` past `bootTimeoutMs`.
  - `killDevice(runner: Runner, cfg: Config, serial: string, pid: number): Promise<void>`. Runs `adb -s <serial> emu kill`, waits up to 15 s for the pid to die, then sends `SIGKILL`.
  - `setAnimationsOff(runner, cfg, serial): Promise<void>`
  - `saveSnapshot(runner, cfg, serial): Promise<void>`. Runs `adb -s <serial> emu avd snapshot save default_boot` and throws on a non-zero exit or output without `OK`.
  - In `tests/fakes.ts`: `FakeRunner implements Runner`. It records every call (`calls: {cmd, args, env}[]`) and takes scripted responses, `onRun(match: (cmd, args) => boolean, result: RunResult | (() => RunResult))` and `onSpawn(pid: number)`, plus a settable `alive: Set<number>`.

- [ ] **Step 1: Write failing tests**
  - `emulatorVersion parses`: the fake returns `'Android emulator version 36.5.11.0 (build_id 15261927) (CL:N/A)\n'`, giving `'36.5.11'`.
  - `launchDevice uses exact flags and AVD home`:
    - Calling `launchDevice(fake, cfg, 'dev-abc123', 5620)` spawns `cfg.emulatorBin` with args deep-equal to `['-avd','dev-abc123','-port','5620','-no-snapshot-save','-no-boot-anim','-no-window']`.
    - `env.ANDROID_AVD_HOME === cfg.avdHome` and `env.ANDROID_SDK_ROOT === cfg.sdkRoot`.
    - With `{ window: true, snapshotSave: true }`, the args are `['-avd','dev-abc123','-port','5620','-no-boot-anim']`. That combination is used only by base builds.
  - `waitBoot succeeds when boot_completed is 1`: getprop returns `''` twice and then `'1\n'`. It resolves.
  - `waitBoot reports FATAL on exit`: the pid is not alive and the log contains `FATAL | Not enough space to create userdata partition`. It rejects with `/emulator exited: .*Not enough space/`.
  - `waitBoot times out`: with `bootTimeoutMs: 50`, the pid stays alive and getprop always returns `''`. It rejects with `/boot timed out/`.
  - `killDevice escalates`: the pid stays alive after `emu kill`. With the wait shortened via an injected `killWaitMs: 50` in cfg, `fake.kill` is called with `'SIGKILL'`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/emulator.ts`. Every call passes `env: { ...process.env, ANDROID_AVD_HOME: cfg.avdHome, ANDROID_SDK_ROOT: cfg.sdkRoot }`. Add `killWaitMs` (default 15000) to `Config` and update Task 1's defaults test.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/emulator.ts src/config.ts tests/fakes.ts tests/emulator.test.ts tests/config.test.ts && git commit -m "Add emulator and adb wrapper"`

### Task 6: Bases

**Files:**
- Create: `src/base.ts`, `tests/base.test.ts`

**Interfaces:**
- Consumes: Task 2 (`TUNED_CONFIG`, `applyConfig`), Task 3 (`withState`, `BaseRecord`, `Flavor`), Task 4 (`assertDiskOk`, `pickPort`), Task 5 (`emulatorVersion`, `launchDevice`, `waitBoot`, `setAnimationsOff`, `saveSnapshot`, `killDevice`)
- Produces:
  - `baseName(flavor: Flavor, api: number): string`
  - `imageFor(flavor: Flavor, api: number): string`
  - `buildBase(runner: Runner, cfg: Config, flavor: Flavor, api: number, io: { waitForUser(prompt: string): Promise<void>; log(msg: string): void }): Promise<BaseRecord>`
  - `listBases(cfg: Config): BaseRecord[]`
  - `removeBase(runner: Runner, cfg: Config, name: string): Promise<void>`. Refuses with `Error('base <name> has <n> active devices')` while leases exist for its flavor and API.
  - `assertBaseUsable(runner: Runner, cfg: Config, flavor: Flavor, api: number): Promise<BaseRecord>`. Throws the missing-base error or the version-mismatch error from Global Constraints, word for word.

- [ ] **Step 1: Write failing tests** (FakeRunner, temp `DROIDPOOL_HOME`)
  - `assertBaseUsable missing`: no base. It rejects with exactly `no base for clean API 35. Build one: droidpool base build clean --api 35`.
  - `assertBaseUsable version mismatch`: the state has `base-clean-35` with `emulatorVersion '36.5.11'` and the fake emulator reports `36.6.11`. It rejects with exactly `base base-clean-35 was built on emulator 36.5.11; emulator is now 36.6.11. Rebuild: droidpool base build clean --api 35`.
  - `assertBaseUsable rejects unsupported api`: `api 36` rejects with `API 36 not supported in v1 (supported: 35)`.
  - `buildBase clean sequence`: the fake scripts sdkmanager, avdmanager, spawn, getprop and snapshot as successes. Assert the calls in order:
    1. `sdkmanager` with `system-images;android-35;google_apis;arm64-v8a`
    2. `avdmanager create avd -n base-clean-35 -k <image> -d pixel_7 --force`, with `input: 'no\n'`
    3. spawn with `snapshotSave: true`
    4. animation `settings put` x3
    5. snapshot save
    6. kill

    Also assert that `config.ini` under `avdHome/base-clean-35.avd` contains every `TUNED_CONFIG` pair, that the state holds a `BaseRecord` with `ramMb: 4096` and `emulatorVersion: '36.5.11'`, and that `io.waitForUser` was not called.
  - `buildBase signed-in waits for user`: the flavor is `signed-in`. The image is `google_apis_playstore`, spawn uses `window: true`, and `io.waitForUser` is called once, before `saveSnapshot`, with a prompt containing `Sign in to Google and Play`.
  - `buildBase failure removes partial base`: snapshot save fails. It rejects, `avdHome/base-clean-35.avd` does not exist, and the state has no base record.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/base.ts`.
  - After `waitBoot`, settle for 30 s (injectable as `cfg.baseSettleMs`, default 30000, added to `Config`), then call `setAnimationsOff`.
  - Building a base checks `assertDiskOk` first.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/base.ts src/config.ts tests/base.test.ts tests/config.test.ts && git commit -m "Add base build, list, remove, validation"`

### Task 7: Pool (get, release, renew, list, reap)

**Files:**
- Create: `src/pool.ts`, `tests/pool.test.ts`

**Interfaces:**
- Consumes: Tasks 2-6
- Produces:
  - `interface DeviceInfo { serial: string; deviceId: string; flavor: Flavor; api: number; project: string; owner: Owner; state: Lease['state'] }`
  - `getDevice(runner: Runner, cfg: Config, req: { flavor: Flavor; api?: number; project: string; owner: Owner; reuseSerial?: string }): Promise<DeviceInfo>`
  - `releaseDevice(runner: Runner, cfg: Config, serial: string): Promise<{ released: boolean; message: string }>`
  - `renewLease(cfg: Config, serial: string): Promise<DeviceInfo>`. For CLI leases it sets `expiresAt = now + cliTtlMs`. It throws for unknown serials.
  - `listDevices(cfg: Config): DeviceInfo[]`
  - `reap(runner: Runner, cfg: Config, now?: number): Promise<string[]>`. Returns the deviceIds it removed.
  - `POOL_FULL_MESSAGE = 'device pool is full (max <n>). Do not start an emulator yourself; retry later or ask the user to release a device.'`, with `<n>` filled in.

- [ ] **Step 1: Write failing tests** (FakeRunner simulating boots, temp home with a fake base dir and a `BaseRecord`)
  - `get clones, launches, returns serial`:
    - `getDevice({flavor:'clean', project:'/p', owner:{kind:'cli', expiresAt}})` returns `serial 'emulator-5620'` and a `deviceId` matching `/^dev-[0-9a-f]{6}$/`.
    - `avdHome/<id>.avd` exists, and its `snapshots/default_boot/hardware.ini` contains no `base-clean-35`.
    - `avdHome/<id>.ini` equals `deviceIni(...)`.
    - `multiinstance.lock` and `hardware-qemu.ini` are absent in the clone.
    - The lease `state` is `'ready'`.
  - `get checks disk before cloning`: add `freeBytesFn: (path: string) => number` to `Config`, defaulting to `freeBytes` from Task 4. The pool calls `assertDiskOk(cfg, cfg.freeBytesFn(cfg.home))`. With free disk under the requirement, it rejects with `/not enough disk/`, and no `cp` call was made.
  - `boot failure cleans up`: the spawned pid dies and the log has a `FATAL` line. It rejects with `/emulator exited/`, the clone dir is gone, and there is no lease.
  - `boot timeout kills and cleans up`: with `bootTimeoutMs: 50`, it rejects with `/boot timed out/`, `killDevice` was invoked (an `emu kill` call was recorded), the clone dir is gone, and there is no lease.
  - `pool full waits then fails`: with `maxDevices: 1`, one lease ready, and `queueWaitMs: 100`, the second `getDevice` rejects with exactly `POOL_FULL_MESSAGE` for n=1, after at least 100 ms.
  - `pool full succeeds when a slot frees`: with `queueWaitMs: 2000`, release the first device after 200 ms. The second `getDevice` resolves.
  - `parallel gets get distinct ports`: `Promise.all` of 3 `getDevice` calls gives serials `emulator-5620`, `emulator-5622` and `emulator-5624` in some order, with 3 distinct deviceIds. A slot is reserved by writing a `'booting'` lease inside the lock before cloning.
  - `release is idempotent`: release a real serial, which gives `{ released: true }`, the dir is gone, and there is no lease. Release it again, which gives `{ released: false, message: 'no device emulator-5620' }` without throwing.
  - `reap removes dead mcp owners after grace`: a lease with `owner {kind:'mcp', pid: <dead>}`. `reap(now)` the first time sets `goneSince` and removes nothing. `reap(now + 120001)` removes it and returns `[deviceId]`.
  - `reap keeps live mcp owners and unexpired cli leases`: a live pid owner and a CLI lease with `expiresAt` in the future are both kept.
  - `reap removes expired cli leases, dead emulators, and unleased dirs`: an expired CLI lease, a lease whose `emulatorPid` is dead, and a stray `avdHome/dev-ffffff.avd` with no lease are all removed. `base-*` dirs are never removed.
  - `reuseSerial adopts a gone owner within grace`: a lease with a dead mcp owner and `goneSince` set. `getDevice({..., reuseSerial, owner:{kind:'mcp', pid: process.pid}})` returns the same serial, no new clone is made, and the owner pid is updated.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/pool.ts`.
  - Flow: `reap`, then `assertBaseUsable`, then reserve inside `withState` (count leases against `maxDevices`, `assertDiskOk`, `pickPort`, push a `'booting'` lease with placeholder `emulatorPid: 0`), then outside the lock: `cloneDir`, rewrite files, launch, update the pid, `waitBoot`, and mark `'ready'`.
  - Any failure after the reservation: `killDevice` if a pid exists, `rm` the dir, and remove the lease.
  - While the pool is full, poll every 1 s until `queueWaitMs`.
  - Leases still `'booting'` with `emulatorPid: 0` are exempt from the dead-emulator reap for `bootTimeoutMs`.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/pool.ts src/config.ts tests/pool.test.ts && git commit -m "Add device pool: get, release, renew, reap"`

### Task 8: CLI and doctor

**Files:**
- Create: `src/cli.ts`, `src/doctor.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7
- Produces:
  - `runCli(argv: string[], deps: { runner: Runner; cfg: Config; out: (s: string) => void; err: (s: string) => void; waitForUser: (p: string) => Promise<void> }): Promise<number>`, which returns the exit code
  - `doctorReport(runner: Runner, cfg: Config): Promise<string>`
- Commands:
  - `base build <clean|signed-in> [--api N]`, `base list`, `base rm <name>`
  - `get [--clean|--signed-in] [--api N] [--project P]` (default `--clean`, project `process.cwd()`, owner CLI with a 2 h TTL). Prints only the serial on stdout.
  - `release <serial>`, `renew <serial>`
  - `ls` (table: serial, id, flavor, api, project, owner, state)
  - `gc` (prints the removed ids)
  - `doctor`

- [ ] **Step 1: Write failing tests** (call `runCli` with fakes, without spawning the bin)
  - `get prints serial only`: `runCli(['get'])` returns `0`, and the output is exactly `'emulator-5620\n'`.
  - `get error goes to stderr with exit 1`: with no base, the code is `1`, stderr contains `droidpool base build clean --api 35`, and stdout is empty.
  - `unknown command`: `runCli(['frob'])` returns `2`, and stderr contains `usage: droidpool`.
  - `ls shows leases`: after `get`, the `ls` output contains `emulator-5620` and `clean`.
  - `every command reaps first`: an expired CLI lease exists. `runCli(['ls'])` does not list it, and its clone dir is gone. Implement this by having `runCli` call `reap` before dispatching any command.
  - `doctor`: the output contains the lines `emulator: 36.5.11`, `bases: 1`, `devices: 0`, `free disk: <n> GB (need <m> GB per device)`, and `bases on disk: <size>`. The size comes from `du -sh` via the runner.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `util.parseArgs`. The bin's main calls `runCli(process.argv.slice(2), realDeps)`, and its `waitForUser` reads a line from stdin.
- [ ] **Step 4: Run `npm test && npm run typecheck`**, then `node src/cli.ts doctor` against the real machine. Expected: PASS, and doctor prints `emulator: 36.5.11`.
- [ ] **Step 5: Commit.** `git add src/cli.ts src/doctor.ts tests/cli.test.ts && git commit -m "Add droidpool CLI and doctor"`

### Task 9: MCP server

**Files:**
- Create: `src/mcp.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Consumes: Task 7
- Produces:
  - `createServer(deps: { runner: Runner; cfg: Config; pid: number }): McpServer`
  - Tools:
    - `get_device { flavor?: 'clean'|'signed-in' (default 'clean'), api?: number, project: string, reuse_serial?: string }` returns `{ serial, deviceId, flavor, api }` as JSON text
    - `release_device { serial: string }` returns the `releaseDevice` message
    - `list_devices {}` returns a JSON array of `DeviceInfo`
  - The owner is always `{ kind: 'mcp', pid: deps.pid }`.
  - Lifecycle: on stdin close or `SIGTERM`/`SIGINT`, release every lease owned by `deps.pid`, then exit. Run `reap` every 30 s with `unref`'d timers.
  - Install: `npm i -E @modelcontextprotocol/sdk@1 zod@3`.

- [ ] **Step 1: Write failing tests**, using the SDK's `InMemoryTransport.createLinkedPair()` and a `Client`.
  - `lists three tools`: the names deep-equal `['get_device','list_devices','release_device']` (sorted).
  - `get_device returns serial`: calling with `{ project: '/p' }` gives result text that parses to `serial 'emulator-5620'`, and the lease owner is `{ kind:'mcp', pid }`.
  - `errors are tool errors, not crashes`: with no base, the result has `isError: true`, and its text contains `droidpool base build clean --api 35`.
  - `shutdown releases owned devices only`: two leases exist, one owned by `pid` and one by another live pid. Calling the exported `shutdown(deps)` leaves only the other lease.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `src/mcp.ts`, exporting `createServer` and `shutdown`. The bin's main connects `StdioServerTransport`.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/mcp.ts tests/mcp.test.ts package.json package-lock.json && git commit -m "Add droidpool MCP server"`

### Task 10: Agent guidance, README, real-emulator smoke

**Files:**
- Create: `guidance/agents.md`, `README.md`, `scripts/e2e.ts`

**Interfaces:**
- Consumes: CLI from Task 8, MCP from Task 9

- [ ] **Step 1: Write `guidance/agents.md`** (for pasting into the global CLAUDE.md), with exactly these rules:
  - Get Android devices only from droidpool: the `get_device` MCP tool, or `droidpool get`.
  - Never run `emulator`, `avdmanager`, or `adb emu kill` yourself.
  - Always use `adb -s <serial>` with the serial you were given. Never assume `emulator-5554`.
  - Release the device with `release_device` when you finish testing.
  - If the pool is full or a base is missing, tell the user. Do not work around it.
- [ ] **Step 2: Write `README.md`.** Cover:
  - install: `npm link` and `claude mcp add droidpool -- droidpool-mcp`
  - building bases
  - CLI usage
  - the disk model, using the spike numbers from the spec
  - the open questions copied from the spec, as "known unknowns"
- [ ] **Step 3: Write `scripts/e2e.ts`.** It exits 0 without doing anything unless `DROIDPOOL_E2E=1`. When enabled, it uses a temp `DROIDPOOL_HOME` and runs:
  1. `base build clean`
  2. two `get` calls
  3. assert two distinct serials, both answering `adb -s <s> shell getprop sys.boot_completed` with `1`
  4. record free bytes, `adb -s <s1> shell dd if=/dev/zero of=/data/local/tmp/blob bs=1m count=200`, `release` both, and print the freed MB
  5. `gc`
  6. assert no `dev-*` dirs remain
  7. print the boot time per device
- [ ] **Step 4: Run** `DROIDPOOL_E2E=1 node scripts/e2e.ts`, with at least 15 GB free and no other emulator on ports 5620-5680. Expected: it prints two serials, boot times under 15 s, and freed MB between 200 and 600, then exits 0. Record the output in `README.md` under "Measured".
- [ ] **Step 5: Commit.** `git add guidance README.md scripts && git commit -m "Add agent guidance, README, and real-emulator smoke test"`

---

## Not covered by this plan (spec open questions, measured after v1 works)
- Concurrent signed-in clones and Google account behavior (needs Mohanned's account and a manual Play purchase test)
- Effect of window mode on snapshot validity
- Base RAM of 3 GB vs 4 GB
- Whether `maxDevices` 3 holds under real load
- Clone resume time vs the original

The e2e script provides the measurement harness for the disk and boot-time questions.
