# droidpool

Disk-light Android emulators for parallel AI coding agents on macOS.

When several agents test Android apps at the same time, they each start emulators on their own. They fight over `emulator-5554`, copy multi-gigabyte AVDs, and leave orphan emulators that keep using RAM and CPU. droidpool gives each agent its own device on request: an APFS clone of a prepared base AVD, booted from a snapshot, deleted when the agent is done.

## At a glance

Measured on an M1 Max with 32 GB RAM:

- A device is ready 9 to 12 s after `get`. It resumes from a snapshot and never cold boots.
- Cloning a 4.8 GB base takes 0.23 s and uses no disk. A device then costs only what it writes.
- Releasing two devices freed about 292 MB and left no files or processes behind.
- Up to 3 devices run at once by default. Each agent gets its own serial.

| | Stock AVDs | droidpool |
|---|---|---|
| Disk per device | Full copy, often 5 to 10 GB | Clone, about what the device writes |
| Startup | Cold boot, or a snapshot that silently breaks | Always resumes the same snapshot |
| Parallel agents | Port clashes, shared `emulator-5554` | One serial per agent, ports allocated |
| Cleanup | Manual | On release, or when the agent goes away |
| Guardrails | None | Disk checks, pool limit, ownership rules |

## Contents

- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [Using with AI agents](#using-with-ai-agents)
- [CLI reference](#cli-reference)
- [Bases](#bases)
- [Leases and cleanup](#leases-and-cleanup)
- [Viewing a device](#viewing-a-device)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Contributing](#contributing)

## Requirements

| Requirement | Notes |
|---|---|
| Apple Silicon Mac, APFS disk | Bases use `arm64-v8a` images. Intel Macs and Linux are not supported. |
| Node 22.18 or newer | droidpool runs TypeScript directly; there is no build step. |
| Android SDK | `emulator`, `platform-tools`, and `cmdline-tools` installed at `cmdline-tools/latest`. Emulator 36.5.11 is the tested version. |
| Java 17 or newer on PATH | Needed by `sdkmanager` and `avdmanager`. |
| About 20 GB free disk | About 5 GB per base, plus 7.2 GB reserved for each running device, plus a 2 GB margin. |

## Quickstart

### 1. Android SDK

With Android Studio, open SDK Manager and install Android SDK Command-line Tools (latest), Android Emulator, and Android SDK Platform-Tools. The SDK lives at `~/Library/Android/sdk`.

Without Android Studio, download "Command line tools only" for Mac from developer.android.com/studio and unpack it so this path exists: `~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager`. Then install the rest:

```bash
export ANDROID_HOME=~/Library/Android/sdk
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "emulator"
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
```

### 2. Install droidpool

```bash
git clone https://github.com/mohn93/droidpool && cd droidpool
npm install
mkdir -p ~/.local/bin
ln -sf "$PWD/src/cli.ts" ~/.local/bin/droidpool
ln -sf "$PWD/src/mcp.ts" ~/.local/bin/droidpool-mcp
```

If `~/.local/bin` is not on your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new shell. Then check the setup:

```bash
droidpool doctor
```

It should print the emulator version and free disk.

### 3. Build a base

A base is a booted, snapshotted emulator that every device is cloned from. Build it once; it takes a few minutes.

```bash
droidpool base build clean
```

### 4. Get a device

```bash
serial=$(droidpool get)
adb -s "$serial" shell getprop ro.build.version.release
droidpool show "$serial"      # optional: opens a mirror window
droidpool release "$serial"
```

### 5. Give it to your agents

```bash
claude mcp add droidpool --scope user -- ~/.local/bin/droidpool-mcp
```

Then add the [agent rules](#agent-rules) to `~/.claude/CLAUDE.md`. Sessions that were already running see the tools after a restart.

### Terms

- **Base**: a prepared AVD plus its boot snapshot, one per flavor and API level.
- **Flavor**: `clean` (Google APIs image) or `signed-in` (Play Store image, signed in to a Google account once during the base build).
- **Device**: a clone of a base, running as one emulator with its own serial.
- **Lease**: droidpool's record of who holds a device and until when.
- **Reap**: tear down devices whose lease expired, whose owner went away, or whose emulator died.

## Using with AI agents

### Register the MCP server

For Claude Code, in every project:

```bash
claude mcp add droidpool --scope user -- ~/.local/bin/droidpool-mcp
```

The tools appear as `mcp__droidpool__get_device` and so on. Without `--scope user` the server is registered for the current project only.

For other MCP clients (stdio):

```json
{
  "mcpServers": {
    "droidpool": { "command": "/Users/you/.local/bin/droidpool-mcp", "args": [] }
  }
}
```

Use an absolute path, and make sure the client's environment has Node 22.18 or newer on PATH. Each agent session starts its own server process, and that process owns the devices it gets.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `get_device` | `project` (required, absolute path of the repo being tested); `flavor`: `clean` (default) or `signed-in`; `api` (default 35, the only supported level); `reuse_serial` (optional) | `{"serial", "deviceId", "flavor", "api"}` |
| `release_device` | `serial` | `released <serial> (<deviceId>)` |
| `show_device` | `serial` | `showing <serial> in a window titled "..."`, or `already showing <serial>` |
| `list_devices` | none | JSON array of `{serial, deviceId, flavor, api, project, owner, state}` |

`get_device` returns only once the device has booted. It waits up to 90 s for a free slot when the pool is full, then up to 180 s for boot, so give your client a tool timeout of at least 5 minutes. The first `show_device` call downloads scrcpy (about 3 s).

Errors come back as tool errors with these messages:

| Situation | Message |
|---|---|
| Pool full after 90 s | `device pool is full (max 3). Do not start an emulator yourself; ...` |
| No base | `no base for <flavor> API <n>. Build one: droidpool base build ...` |
| Base needs a rebuild | `... Rebuild: droidpool base build ...` |
| Base being rebuilt | `base <name> is being rebuilt (pid N); retry when the build finishes` |
| Low disk | `not enough disk: X GB free, need Y GB with N devices running` |
| Device still booting | `device <serial> is still booting` |
| Someone else's device | `device <serial> belongs to another session` |
| Reusing a live device | `device <serial> is owned by another live session` |
| Unknown serial | `no device <serial>` |

### Ownership

- `release_device` and `show_device` work only on your own devices, or on devices whose owner is gone (a dead MCP process or an expired CLI lease).
- `droidpool release` refuses a device owned by a live MCP session unless you pass `--force`.
- CLI devices have no owner process, so any `droidpool release` can free them. Agents must release only the serials they got.

### Using the device

Pass the serial to every tool. Never assume `emulator-5554`.

```bash
adb -s emulator-5622 install app.apk
flutter run -d emulator-5622
ANDROID_SERIAL=emulator-5622 ./gradlew connectedAndroidTest
```

### Agent rules

Paste this into `~/.claude/CLAUDE.md`, or your client's equivalent. The same text is in [guidance/agents.md](guidance/agents.md).

```markdown
## Android devices (droidpool)
- Get Android emulators only from droidpool: the `get_device` MCP tool (pass `project` = absolute path of the repo; flavor `clean`, or `signed-in` for Google account / Play Store / purchases), or `droidpool get` on the command line.
- Never run `emulator`, `avdmanager`, or `adb emu kill` yourself, and never create AVDs.
- Always use the serial you were given: `adb -s <serial>`, `flutter -d <serial>`, `ANDROID_SERIAL` for Gradle. Never assume `emulator-5554`.
- After a reconnect, call `get_device` with `reuse_serial`, then use the serial it returns; it may be a new device.
- Release only devices you got. Never use `droidpool release --force`.
- CLI leases expire after 2 hours; run `droidpool renew <serial>` during long work.
- Devices have no window. When the user needs to see or use the device, call `show_device` (or `droidpool show <serial>`). Do not install or launch scrcpy yourself.
- Release the device with `release_device` when you finish testing.
- If the pool is full, a base is missing or being rebuilt, or disk is low, tell the user. Do not work around it.
```

## CLI reference

| Command | What it does | Notes |
|---|---|---|
| `droidpool get [--clean\|--signed-in] [--api N] [--project P]` | Leases a device and prints its serial | Defaults: clean, API 35, project = current directory. 2 hour lease. |
| `droidpool release <serial> [--force]` | Stops the device and deletes its clone | `--force` is only needed for a device a live MCP session holds |
| `droidpool renew <serial>` | Resets a CLI lease to 2 hours from now | No effect on MCP devices |
| `droidpool show <serial>` | Opens a scrcpy mirror window | Downloads scrcpy the first time |
| `droidpool ls` | Lists devices | Columns: serial, id, flavor, API, project, owner (`cli` or `mcp:<pid>`), state |
| `droidpool gc` | Reaps now and prints what it removed | Every command reaps first anyway |
| `droidpool doctor` | Shows bases, devices, free disk, base size, emulator version mismatches | |
| `droidpool base build <clean\|signed-in> [--api N]` | Builds a base | Refused while devices from that base exist |
| `droidpool base list` | Lists bases | |
| `droidpool base rm <name>` | Removes a base | Refused while it is being built or has devices |

Exit codes: 0 on success, 1 on an error, 2 on a usage error (usage is printed).

## Bases

```bash
droidpool base build clean        # google_apis image, API 35
droidpool base build signed-in    # google_apis_playstore image, API 35
```

A build installs the system image if needed, creates a tuned AVD (4 GB RAM), boots it, lets it settle for 30 s, turns animations off, saves the `default_boot` snapshot, and records the emulator version.

For `signed-in`, the build opens an emulator window and pauses. Sign in to Google and the Play Store there, finish any setup prompts, then press Enter in the terminal. Every clone starts signed in.

`get` never builds a base. It refuses a base that is missing, being rebuilt, or built on a different emulator version than the one installed. After an SDK emulator update, rebuild your bases.

## Leases and cleanup

- CLI devices expire 2 hours after `get` unless renewed with `droidpool renew <serial>`.
- MCP devices live as long as the server process that got them. After it exits, they are kept for 2 minutes so a reconnecting session can reclaim them with `reuse_serial`.
- `reuse_serial` returns the same device only if it is still within those 2 minutes, its emulator is alive, and the flavor and API match. Otherwise the agent gets a new device, so always use the returned serial.
- The pool holds 3 devices. A `get` on a full pool waits up to 90 s for a free slot.
- Reaping stops the emulator, closes any mirror window, and deletes the clone and its logs. It runs at the start of every CLI command, every 30 s in each MCP server, and once more just after the grace period when an MCP server exits cleanly.
- If an MCP server crashes, its devices are reaped by the next droidpool process that runs: another agent's server, or any CLI command.

```
get ──> booting ──> ready ──> release ──> deleted
                      │
   MCP server exits ──┤ kept 2 min, reclaimable with reuse_serial, then reaped
   CLI lease > 2 h ───┤ reaped (renew resets the 2 hours)
   emulator dies ─────┘ reaped
```

## Viewing a device

Devices run without a window. `droidpool show <serial>` (or `show_device`) opens a scrcpy mirror window titled with the serial and project, where the user can watch or interact. The window closes when the device is released.

droidpool downloads scrcpy v5.0.1 once from the official GitHub release into `~/.droidpool/tools` and checks it against a pinned SHA-256. Homebrew is not used. scrcpy talks to the SDK's adb, so it does not start a second adb server.

## How it works

```
 agent ── get_device ──┐
 shell ── droidpool get┤
                       v
        reap, then lock state.json
        check pool size, free disk, base not being rebuilt
        reserve a lease (state: booting) and a free port
                       │
   ~/.droidpool/avd/base-clean-35.avd      prepared AVD + default_boot snapshot
                       │  cp -c -R  (APFS clone, no blocks copied)
                       v
   ~/.droidpool/avd/dev-xxxxxx.avd         rewrite the snapshot's paths and name
                       │
   emulator -avd dev-xxxxxx -port P -no-snapshot-save -no-boot-anim -no-window
                       │  wait for sys.boot_completed
                       v
        lease ready, serial emulator-P returned
```

Each device is an APFS clone of the base directory, so it shares the base's blocks, including the 3.5 GB `ram.bin`, and pays only for blocks it writes. droidpool checks that the base and the clone are on the same APFS volume before cloning, because `cp -c` would otherwise fall back to a full copy without saying so. Every device launches with the same fixed flags and `-no-snapshot-save`, so the base snapshot is never rewritten and stays valid.

More detail on the disk model, snapshots, state locking, and reaping is in [docs/how-it-works.md](docs/how-it-works.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DROIDPOOL_HOME` | `~/.droidpool` | State, bases, devices, logs, scrcpy. Must be on an APFS volume. |
| `ANDROID_SDK_ROOT` or `ANDROID_HOME` | `~/Library/Android/sdk` | SDK location |
| `ANDROID_EMULATOR_HOME` or `ANDROID_USER_HOME` | `~/.android` | The emulator's own home. droidpool only removes the per-port files its devices leave there. |

droidpool never reads or writes `~/.android/avd`; your own AVDs are untouched.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `sdkmanager failed: ... ENOENT` | cmdline-tools missing, or not at `cmdline-tools/latest` | Install them at that path (Quickstart step 1), or point `ANDROID_HOME` at the SDK that has them |
| `sdkmanager failed: ...` mentioning Java | No JDK on PATH | Install Java 17 or newer; check with `java -version` |
| `sdkmanager failed: ...` mentioning licenses | SDK licenses not accepted | Run `sdkmanager --licenses`, then build again |
| `could not parse emulator version from: ` | `$ANDROID_HOME/emulator/emulator` is missing | `sdkmanager "emulator"` |
| `no base for clean API 35. Build one: ...` | No base yet | Run the command in the message |
| `base ... was built on emulator A; emulator is now B. Rebuild: ...` | The SDK emulator was updated, which invalidates snapshots | Run the rebuild command in the message |
| `base ... has no snapshot on disk. Rebuild: ...` | An interrupted build or deleted files | Run the rebuild command in the message |
| `not enough disk: X GB free, need Y GB` | Each running device reserves 7.2 GB, plus a 2 GB margin | Free space, or release devices |
| `device pool is full (max 3)` | Three devices are leased | `droidpool ls`, then release one |
| `device ... belongs to a live MCP session (pid N); pass --force ...` | An agent session still holds the device | Release it from that session, or pass `--force` |
| `base ... has N active devices; release them before rebuilding` | Devices are cloned from that base | Release them, then rebuild |
| `clone failed (APFS required): ...` | `DROIDPOOL_HOME` is not on one APFS volume | Move `DROIDPOOL_HOME` to an APFS volume |
| `emulator exited: ...` or `boot timed out after 180s` | The emulator failed to start | Read `~/.droidpool/logs/<device or base>.log` |
| `API 34 not supported in v1 (supported: 35)` | Only API 35 is supported | Omit `--api`, or pass `--api 35` |
| Signed-in build seems stuck after sign-in | It waits for Enter in the terminal | Press Enter in the terminal running `base build` |
| `droidpool: command not found` | `~/.local/bin` is not on PATH | See Quickstart step 2 |
| A syntax error on a `type` or `interface` line | The `node` on PATH is older than 22.18 | Upgrade Node |

## Limitations

- macOS on Apple Silicon only. Linux (reflinks or qcow2 overlays), Windows, remote pools, and physical devices are not supported.
- API 35 only.
- Running several signed-in devices at once is untested. They share one Google account and device identity, and Google may flag or sign out the account. Prefer one signed-in device at a time.
- Space freed inside a guest is not returned to the host (`fstrim` needs root on google_apis). This is fine for short-lived devices.
- Open questions and the original measurements are in [docs/how-it-works.md](docs/how-it-works.md#open-questions).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
