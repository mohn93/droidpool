# droidpool: disk-light Android devices for parallel agents (design)

Date: 2026-10-19. Status: draft for approval. "droidpool" is a working name (my call).

## Intent
Mohanned runs several AI coding agents at once, on different projects. Each agent needs its own Android device to install and test its app. Today every agent improvises:
- **Launch:** its own `emulator -avd ...` command, with about a dozen different flag combinations.
- **AVDs:** it creates AVDs with `avdmanager` and abandons them. At least 8 were seen across about 53 sessions, and 3 remain.
- **Device:** it assumes `emulator-5554`.

The result is gigabytes of disk that only grow, cold boots because changing flags breaks Quickboot snapshots, RAM and CPU starvation, and agents colliding over one device.

droidpool hands each agent a device on request, built so that a device costs almost no disk. It is for Mohanned first. Keep it clean enough to publish for other developers later.

## Priorities (Mohanned's ranking)
1. **Barely use disk.** This is the top goal.
2. Stay light on RAM and CPU over a long day.
3. Start fast. This is a nice-to-have, and largely solved by snapshots (about 5 to 7 s).

## Goals
- An agent gets a working device by saying only "clean" or "signed-in", plus an optional API level (default 35). It gets back an adb serial.
- A device's disk cost is roughly the data it writes, not a full AVD copy.
- Devices are deleted when released, and also when the agent that leased them disappears. Nothing leaks.
- Launch flags are owned by the tool, never by agents, so snapshots stay valid.
- Several devices run at once without colliding.
- "Signed-in" devices start already signed into Mohanned's Google account, with the Play Store, so they can install apps from Play and test purchases (license-tester account). Mohanned signs in once per base, not per device.

## Non-goals (v1)
- Replacing Google's emulator or QEMU. droidpool sits on top of the stock emulator, 36.5.11 today.
- Windows and Linux support. Keep the clone mechanism behind an interface so it can be added later (see "Later").
- Persisting a single device's app data between leases. What survives is the Google account, which comes from the base.
- A GUI.
- Physical devices.

## Anti-goals (failure even if it "works")
- Orphaned clones or running emulators that quietly eat disk or RAM. This is worse than today.
- Agents still able, or still encouraged, to call `emulator` or `avdmanager` directly.
- Filling the disk to the point the emulator refuses to start. This happened twice during research ("Not enough space to create userdata partition", which needs 1.2x the data partition size).
- Breaking the user's existing AVDs in `~/.android/avd`.

## Evidence from research (2026-10-18/19, M1 Max, 32 GB, macOS 26.7.1)
- Cold boot is 15 to 25 s. Snapshot resume is 5 to 7 s. A brand-new AVD's first boot is about 90 s.
- Any change in launch flags or hardware config silently invalidates the snapshot. The emulator then cold-boots and is slower than a plain cold boot.
- The tuned AVD `fast_api35` uses google_apis, 6 vCPU, 4 GB RAM and host GPU. On one cold-boot run, guest free RAM after boot was about 2.2 GB, against about 0.7 GB for the old 2 GB/4-vCPU config.
- Emulator 37.2.12 benchmarked slower than 36.5.11, so the tool stays on 36.5.11.
- **Spike (APFS clone):**
  - Copying a full AVD directory with `cp -c -R` (APFS clonefile) took 0.23 s and used 0 MB of disk for 4.8 GB of logical data.
  - After rewriting the AVD name and paths in `snapshots/default_boot/hardware.ini` and writing a matching `<name>.ini`, the clone loaded `default_boot` successfully, with the guest settings carried over. Clone resumes took 6.5 to 10.8 s with host load at 14 to 17.
  - The clone and the original ran at the same time on different ports.
  - The clone wrote 200 MB inside the guest. Deleting the clone freed 245 MB, so per-device cost is about what it writes.
  - The 3.5 GB `ram.bin` stayed shared and was never rewritten.
  - qcow2 overlays reference their base by relative path, so they survive cloning.
- `fstrim` is not available as a non-root shell on google_apis, so space freed inside a guest does not return to the host. That is acceptable, because devices are short-lived and deleting a clone reclaims everything.

## Design

### Concepts
- **Base:** a frozen AVD plus its Quickboot snapshot, one per (flavor, API level). Examples are `clean-35` (google_apis) and `signed-in-35` (google_apis_playstore). A base is never launched after it is frozen. To change it, rebuild it.
- **Device:** an APFS clone of a base, owned by one lease, deleted on release.
- **Lease:** a record linking a device to its requester (project path, agent or session id), its serial and port, and a heartbeat or expiry.

### Storage
droidpool keeps its own AVD home (`~/.droidpool/avd`, used through `ANDROID_AVD_HOME` when it launches), separate from `~/.android/avd`. The user's existing AVDs are never touched, and Android Studio's device list stays clean.

### Building a base
- `droidpool base build clean --api 35`: install the system image if missing, create the AVD with the tuned config from `make-fast-avd.sh`, and cold boot. Then wait for boot plus a settle period, set animation scales to 0, save `default_boot`, shut down, and mark the base frozen.
- `droidpool base build signed-in --api 35`: same, but with the Play Store image and a visible window. Pause while Mohanned signs into Google and Play by hand, then snapshot on confirmation.
- Base RAM size is fixed at build time, because it sets the `ram.bin` size and is part of the snapshot's validity. The default is 4 GB (see open questions).

### Getting a device
1. Check limits:
   - free disk must be at least the data partition size x 1.2 plus a margin;
   - running devices must be below the configured maximum.
   If either check fails, return a clear error to the agent. Do not start a degraded device.
2. Clone the base directory with clonefile into `~/.droidpool/avd/<device-id>.avd`, rewrite the name and paths in `snapshots/default_boot/hardware.ini`, write `<device-id>.ini`, and remove `multiinstance.lock` and `hardware-qemu.ini`.
3. Pick a free even port. Launch with the tool's fixed flag set: `-no-snapshot-save -no-boot-anim -no-window -port <p>`, with `ANDROID_AVD_HOME` set.
4. Wait for `sys.boot_completed`, then return `{ serial: "emulator-<p>", deviceId, flavor, api }`.

### Releasing and cleanup
- `release`: kill the emulator (`adb emu kill`, falling back to process kill), wait for exit, delete the clone, and remove the lease.
- **Reaper:** on every command, and periodically from the MCP server, delete expired leases, devices whose emulator process died, and clone directories with no lease.
- `droidpool gc` runs the same cleanup on demand. `droidpool doctor` reports bases, devices, actual disk freed or used, and free space.

### Interfaces
- **CLI** (for Mohanned): `droidpool base build|list|rm`, `droidpool get [--clean|--signed-in] [--api N]`, `droidpool release <serial>`, `droidpool ls`, `droidpool gc`, `droidpool doctor`.
- **MCP server** (for agents): `get_device`, `release_device`, `list_devices`. Agents pass the serial to flywheel-qa (`qa_start` takes `deviceId`) and to adb.
- **Agent guidance:** a short snippet for global CLAUDE.md, or a small skill, that says "get Android devices from droidpool; never run `emulator` or `avdmanager` directly."

### Scope of integration (Mohanned's decision)
v1 ships droidpool plus agent guidance only (a CLAUDE.md snippet or a skill). Existing tools and skills that start emulators themselves, such as the Flutter-run skill, are not changed in v1. Moving them onto droidpool is follow-up work, one tool at a time. flywheel-qa needs no change, because it already attaches by `deviceId`.

### Repository (Mohanned's decision)
droidpool lives in a new git repo at `/Users/mohn93/Desktop/side_projects/android`, the current research folder. Work happens on a `dev` branch per the global workflow. The research files (`FINDINGS.md`, `make-fast-avd.sh`, `run-fast-avd.sh`) stay in the repo as reference.

### How it gets made (agreed defaults)
- TypeScript on Node (matches flywheel-qa), as a CLI plus an MCP server in one package.
- Mac first. Clone mechanism is APFS clonefile (`cp -c`, or the clonefile syscall through a small native call or `cp`).
- Stock Android Emulator 36.5.11 from the main SDK.

## Decisions made by Claude (not discussed with Mohanned; check these)
- **Lease lifetime.** The MCP server is a stdio process, one per agent session, which is how Claude Code runs it. Leases taken through it end when that process exits, after a 2-minute grace period to cover reconnects and `/clear`. Leases taken through the CLI expire after 2 hours unless renewed with `droidpool renew <serial>`. A lease never expires just because it sits idle while its owner is alive.
- **Missing base.** `get_device` never builds a base. It returns an error that names the exact `droidpool base build ...` command for Mohanned to run. v1 supports API 35 only. This avoids surprise multi-GB downloads and 90 s waits.
- **Pool full.** `get_device` waits up to 90 s for a slot, staying under typical MCP tool timeouts, then fails. The error says the pool is full and that the agent must not start an emulator itself. Signed-in devices share the same queue. If open question 1 shows concurrent signed-in clones are unsafe, the signed-in limit becomes 1.
- **Emulator version pinning.** Each base records the emulator version it was built with. If the main SDK emulator version changes, `get` refuses with "base built on X, emulator is now Y, rebuild with `droidpool base build ...`". `doctor` reports the mismatch. No vendored emulator copy, since disk is the top priority.

## Open questions for the builder to settle by measurement
1. **Concurrent signed-in clones.** Does Google flag or sign out the account when several clones of one signed-in device run at once? All clones share Android ID and GSF ID. Test with 2 to 3 clones doing a Play install and a test purchase. If it breaks, limit signed-in devices to one at a time and queue the rest. Changing device identifiers is a non-goal.
2. **Window mode.** Does adding or removing `-no-window` affect snapshot validity? If it does, offer "watch" mode only as a separate base.
3. **Real per-device disk cost** over a realistic agent session (app install, test run), measured cleanly by deleting the clone and reading the freed space, as the spike did.
4. **Base RAM size.** 4 GB gives a 3.5 GB `ram.bin` per base. Try 3 GB: smaller bases, and more devices fit in host RAM.
5. **Maximum concurrent devices.** The default is 3 on a 32 GB host. Confirm it under real load.
6. **Clone resume time.** The spike measured 6.5 to 10.8 s against 5 s for the original. Find out whether this is cold page cache on the shared `ram.bin` or host load.

## Later (not v1)
- **Linux:** reflink clones on btrfs or XFS, or qcow2 overlays on a shared read-only base.
- **Windows:** qcow2 overlays (ReFS block cloning where available).
- A VPS or remote pool for headless QA devices.
- Publishing for other developers.
