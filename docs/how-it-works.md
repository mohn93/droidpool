# How droidpool works

This page covers the parts of droidpool that the README only summarizes: bases, the disk model, snapshots, state and locking, reaping, and ports.

## Files on disk

```
~/.droidpool/
  state.json              bases, leases, and builds in progress
  avd/
    base-clean-35.avd     a base: tuned AVD plus its default_boot snapshot
    base-clean-35.ini
    dev-3f9a1c.avd        a device: APFS clone of a base
    dev-3f9a1c.ini
  logs/                   one log per base and per device; device logs are deleted with the device
  tools/                  the pinned scrcpy release
```

`ANDROID_AVD_HOME` points at `~/.droidpool/avd` for every emulator droidpool starts, so `~/.android/avd` is never read or written.

## Bases

`droidpool base build <flavor>` does the following:

1. Claims the build in `state.json`. It is refused if another live process is building the same base, or if devices cloned from it are running.
2. Installs the system image with `sdkmanager` (`google_apis` for clean, `google_apis_playstore` for signed-in, both `arm64-v8a`).
3. Creates the AVD with `avdmanager` and applies the tuned settings in `src/avdfiles.ts`: 4 GB RAM, 6 cores, host GPU, a 6 GB data partition, and forced fast boot.
4. Boots it on a port above the pool range, waits for `sys.boot_completed`, lets it settle for 30 s, and turns animations off.
5. For signed-in, opens a window and waits for the user to sign in and press Enter.
6. Saves the `default_boot` snapshot explicitly, stops the emulator, and records the emulator version.

If the build fails after `avdmanager` has replaced the previous base, the partial files and the base record are removed. If it fails before that point (for example, the image download fails), the previous base is kept.

While a build is running, `get` refuses that base. A build record left by a process that died does not block anything.

## Disk model

`cp -c -R` uses APFS clonefile. The copy shares every block with the base until one side writes to it. Cloning a 4.8 GB base took 0.23 s and used 0 MB of disk. A device that wrote 200 MB in the guest freed 245 MB when deleted, so a device costs about what it writes. The 3.5 GB `ram.bin` stays shared and is never rewritten.

`cp -c` falls back to a full copy without any error when cloning is impossible, for example across volumes or on a non-APFS filesystem. So droidpool refuses up front unless the base and the destination are on the same APFS volume and the destination does not exist yet. It never falls back to a full copy.

Before a `get`, droidpool requires free space of 1.2 x the 6 GiB data partition for the new device and for each device already running, plus a 2 GiB margin. Clones start near zero bytes, but each may grow to its data partition, so running devices keep their share reserved. `base build` applies the same check.

Space freed inside a guest is not returned to the host, because `fstrim` needs root on google_apis images. This is acceptable because devices are short-lived.

## Snapshots

A Quickboot snapshot is only valid if the emulator is launched with the same configuration it was saved with. A different flag or config value makes the emulator cold boot without saying why. droidpool owns the launch command, so every device starts the same way:

```
emulator -avd <id> -port <port> -no-snapshot-save -no-boot-anim -no-window
```

`-no-snapshot-save` keeps the base snapshot from ever being rewritten. Bases are built with the same flag and save their snapshot explicitly. An earlier version let the emulator save on exit, which raced with shutdown and left a truncated `ram.bin`. Every boot after that was a cold boot.

After cloning, droidpool rewrites the AVD name and paths in `snapshots/default_boot/hardware.ini`, writes a matching `<id>.ini`, and removes `multiinstance.lock` and `hardware-qemu.ini`, so the clone loads the base snapshot as its own.

Each base records the emulator version it was built with. When the installed emulator changes, `get` refuses the base until it is rebuilt, because a snapshot from another emulator version does not load.

## State and locking

`state.json` holds bases, leases, and builds in progress. Every change happens under a lock directory (`state.json.lock`, created with `mkdir`). The lock holds the owner's pid. The new state is written to a temp file and renamed over the old one, so readers never see a partial file.

A lock older than 30 s, or one whose owner process is dead, may be broken. Breaking a lock is serialized by a second lock, so two processes cannot break and retake it at the same time. A holder that loses its lock aborts instead of writing.

Processes are recorded with their pid and start time. macOS reuses pids, so a pid alone could name an unrelated process hours later. droidpool treats a process as alive only when both match, and never signals a process whose start time differs.

## Leases and reaping

A lease records the device, its port and serial, its emulator process, its owner, and its state (`booting` or `ready`).

- A CLI owner has an expiry time, 2 hours after `get` or `renew`.
- An MCP owner is the server process. When it exits cleanly, it marks its leases as gone and schedules a `droidpool gc` for just after the 2-minute grace period.

A reap removes a lease when any of these hold:

- the CLI lease has expired;
- the MCP owner has been gone for more than 2 minutes;
- the emulator has died;
- the lease is still booting and the process that started it is gone, or it has been booting for longer than the boot timeout plus 60 s.

Tearing a device down closes its mirror window, asks the emulator to exit (`adb emu kill`), and kills its process group if it is still running after 15 s. It then deletes the clone, its logs, and the emulator's `modem-nv-ram-<port>` file. If the emulator's pid was never recorded, droidpool finds it by its `-avd <id>` argument. Device files and logs with no lease are deleted as strays.

Reaps run at the start of every CLI command, every 30 s in each MCP server, and in the delayed `gc` after an MCP server exits. Ctrl-C, SIGTERM, or SIGHUP during `get` or `base build` stops the emulators and child processes that command started.

## Ports

Devices use even ports from 5620 to 5680, so at most 31 can exist at once (the pool limit is 3 by default). Base builds use 5682 to 5700, so they never collide with a device. Both skip any port that `adb devices` already lists, including emulators droidpool does not own.

## Measurements

From live runs on an M1 Max with 32 GB RAM:

| Measurement | Result |
|---|---|
| `get` to a ready device, from snapshot | 9 to 12 s |
| Base snapshot load | 3 to 5 s |
| Clone a 4.8 GB base | 0.23 s, 0 MB |
| Two devices running in parallel | Worked |
| Disk freed by releasing two devices | About 292 MB, no leftovers |
| First scrcpy download | About 3 s |

The research that led to droidpool is in [research/](research/).

## Open questions

1. Can several signed-in clones of one device run at once? They share the Android ID and the Google Services Framework (GSF) ID, and Google may flag or sign out the account.
2. Signed-in bases are built with a window and their clones run without one. Does that change snapshot validity, so that signed-in clones cold boot?
3. What is the real per-device disk cost over a typical agent session (app install, test run)?
4. Would 3 GB of guest RAM give smaller bases and fit more devices in host RAM?
5. Is 3 the right default for concurrent devices on a 32 GB host under real load?
6. How do RAM and CPU behave over sessions that last several hours?
