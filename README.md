# droidpool

Disk-light Android emulator clones for parallel AI agents. An agent asks for a device ("clean" or "signed-in", API 35) and gets an adb serial. Each device is an APFS clone of a frozen base AVD, so it costs roughly the data it writes. Devices are deleted on release, or when the agent that leased them disappears.

Mac (APFS) only in v1. Uses the stock Android emulator; 36.5.11 is the tested version.

## Install

```
npm install
npm link
claude mcp add droidpool -- droidpool-mcp
```

Then paste `guidance/agents.md` into `~/.claude/CLAUDE.md` so agents use droidpool and not `emulator` or `avdmanager`.

Requires Node >= 22.18 and an Android SDK (`ANDROID_SDK_ROOT`, `ANDROID_HOME`, or `~/Library/Android/sdk`) with the emulator, platform-tools and cmdline-tools.

Environment:
- `DROIDPOOL_HOME`: state, AVDs and logs. Default `~/.droidpool`. droidpool never reads or writes `~/.android/avd`.
- `ANDROID_SDK_ROOT` / `ANDROID_HOME`: SDK location.

## Building bases

A base is a frozen AVD plus its Quickboot snapshot, one per (flavor, API). `get` never builds one; a missing base is an error that names the command to run.

```
droidpool base build clean              # google_apis, API 35
droidpool base build signed-in          # google_apis_playstore, API 35
droidpool base list
droidpool base rm base-clean-35
```

Building takes a few minutes (system image install if missing, first boot, snapshot). For `signed-in`, the build pauses so you can sign into the Google account once; every clone starts signed in. Each base records the emulator version it was built with. If the SDK emulator changes, `get` refuses until you rebuild.

## CLI

```
droidpool get [--clean|--signed-in] [--api N] [--project P]   # prints the serial
droidpool release <serial>
droidpool renew <serial>      # extend a CLI lease
droidpool ls
droidpool gc                  # reap expired leases, dead emulators, orphan clones
droidpool doctor              # bases, devices, free disk, emulator version mismatches
```

CLI leases expire after 2 hours unless renewed. Devices taken through the MCP server survive for 2 minutes after that server process exits, so a reconnecting session can reclaim them with `reuse_serial`. After that they are reaped.

## MCP tools

- `get_device`: `flavor` (clean | signed-in), `api`, `project` (absolute path), `reuse_serial`. Returns `{ serial, deviceId, flavor, api }`. Waits up to 90 s if the pool is full (max 3 devices), then fails.
- `release_device`: `serial`.
- `list_devices`.

Launch flags are owned by droidpool (`-avd <id> -port <p> -no-snapshot-save -no-boot-anim -no-window`), so snapshots stay valid.

## How the disk model works

`cp -c -R` (APFS clonefile) copies a base AVD without copying its blocks. Spike results (M1 Max, 32 GB):

- Cloning a 4.8 GB AVD directory took 0.23 s and used 0 MB of disk.
- After rewriting the AVD name and paths in `snapshots/default_boot/hardware.ini` and writing a matching `<name>.ini`, the clone loaded the `default_boot` snapshot.
- Clone and original ran at the same time on different ports.
- A clone that wrote 200 MB in the guest freed 245 MB when deleted: per-device cost is about what it writes.
- The 3.5 GB `ram.bin` stays shared and is never rewritten.
- Clone resume took 6.5 to 10.8 s (host load 14 to 17), against about 5 s for the original.

Free space inside a guest is not returned to the host (`fstrim` needs root on google_apis), which is fine because devices are short-lived. If cloning fails, droidpool aborts; it never falls back to a full copy. `get` also checks free disk first (1.2 x the 6 GiB data partition, plus 2 GiB margin), since the emulator refuses to start without that room.

## Smoke test

```
DROIDPOOL_E2E=1 node scripts/e2e.ts
```

Uses a temp `DROIDPOOL_HOME`, builds a clean base, gets two devices, checks both boot and load the snapshot, writes 200 MB in one, releases both, and prints boot seconds and freed MB. Needs about 15 GB free and ports 5620-5680 unused. Without `DROIDPOOL_E2E=1` it exits 0 immediately.

### Measured

Pending first live run.

## Known unknowns

Open questions to settle by measurement:

1. Concurrent signed-in clones: does Google flag or sign out the account when several clones of one signed-in device run at once (shared Android ID and GSF ID)? If so, signed-in is limited to one device at a time.
2. Window mode: does adding or removing `-no-window` affect snapshot validity? If so, a watch mode needs its own base.
3. Real per-device disk cost over a realistic agent session (app install, test run).
4. Base RAM size: 4 GB gives a 3.5 GB `ram.bin`. Would 3 GB give smaller bases and fit more devices in host RAM?
5. Maximum concurrent devices: default 3 on a 32 GB host; confirm under real load.
6. Clone resume time: 6.5 to 10.8 s against 5 s for the original. Cold page cache on the shared `ram.bin`, or host load?

## Not in v1

Linux (reflinks or qcow2 overlays), Windows, remote pools, physical devices, GUI.
