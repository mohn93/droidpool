# Android emulator speed on Mac: findings (2026-10-18)

## Machine
- Apple M1 Max, 10 cores (8 performance, 2 efficiency), 32 GB RAM, macOS 26.7.1
- Android Emulator 36.5.11. The SDK manager offers 37.2.12.
- Disk: 9.5 GB free of 926 GB (99% full)

## Why the iOS Simulator feels faster
The iOS Simulator is not a VM. Simulated iOS processes are native arm64 macOS processes. They share the host kernel, memory allocator, and filesystem, so there is no guest kernel boot and no virtual disk. The Android Emulator is a full VM (QEMU on Hypervisor.framework). It boots a Linux kernel, then init, Zygote/ART, and system_server, inside fixed guest RAM and on a virtual disk.

So no tuning makes a cold boot as fast as the simulator. The realistic targets are:
1. Never cold boot. Resume from a snapshot (tested here at about 6 s).
2. Give the guest enough RAM and CPU that it never thrashes.
3. Strip work the guest does not need: Play services, animations, boot animation, window chrome.

## Measured here (fametwin_pixel_api35: API 35, Play image, 4 vCPU, 2 GB RAM)
| Scenario | Time to `sys.boot_completed` |
|---|---|
| Cold boot | 15.6 s |
| "Quickboot" with a broken snapshot (silent cold-boot fallback) | 16.9 s |
| Cold boot that also saves a fresh snapshot | 22.5 s |
| Snapshot resume (valid snapshot) | 6.2 s / 5.9 s |

The running `flywheel_qa_api35` (same config, about 15 minutes after boot) showed:
- Guest load average 6.06 on 4 vCPUs, which means CPU-starved.
- 400 MB available of 2 GB guest RAM, which means memory-starved (lowmemorykiller pressure, app cold starts).
- GPU path was fine: host Metal through the GLES translator, even though `hw.gpu.enabled=no` is in config.ini.

## Findings, ranked by impact
1. **Snapshots silently break.** The `default_boot` snapshot metadata held a failure code, so "Quickboot" did a full cold boot that was slower than a plain cold boot. Any change in launch flags or hardware config invalidates the snapshot. In this test, the cause was adding `-no-audio`. Fix: launch with the same flags every time. Take one clean snapshot, then run with `-no-snapshot-save` so every launch resumes the same known-good state. That cut boot time by about 2.5x.
2. **2 GB RAM is too little for API 35 with Play.** Use 4 GB (the emulator itself forces at least 4 GB for API 37). With 32 GB on the host, this costs nothing.
3. **4 vCPUs on an 8 P-core host.** Use 6 vCPUs. Leave headroom for the host's Gradle and IDE.
4. **Play Store image.** `google_apis_playstore` runs Play Store and its auto-update services, which add steady background work. Use `google_apis` unless you need Play. The `ps16k` (16 KB page) variant is only needed for 16 KB page-size testing.
5. **Disk is 99% full.** Snapshot RAM files are 0.7 to 2 GB each, and the data partition is a growing qcow2 file. Low free space makes snapshot saves fail and slows APFS. Free up at least 30 GB.
6. **Emulator version.** 36.5.11 is behind. Release notes for 36.6.x include macOS 26 fixes, including a Hypervisor.framework resource leak on close. One personal report says 36.5.10 on macOS 26 can stall the host GPU display pipeline, which shows up as SystemUI ANRs with an idle CPU. 37.2.12 is available.
7. **Guest-side trims for dev and test loops:** set the animation scales to 0, use `-no-boot-anim`, and use `-no-window` for headless CI/agent runs. A smaller screen (for example 1080x1920 at 420 dpi) reduces GPU and screen-capture cost.
8. **Host contention.** Running two emulators at once (the case here) roughly halves each one's headroom. Run one at a time.

## Benchmark round 2: tuned AVD and emulator 37.2.12
- `fametwin` is the old config: Play image, 4 vCPU, 2 GB RAM.
- `fast_api35` is the tuned config: google_apis, 6 vCPU, 4 GB RAM, host GPU, no frame, no boot animation.
- Emulator 37.2.12 is installed side by side at `~/Library/Android/sdk-emu37`; the main SDK stays on 36.5.11.
- Metrics:
  - Boot is time to `sys.boot_completed`.
  - Guest RAM and guest load were read 45 s after boot.
  - App start is the median of 5 `am start -W -S` cold starts of Settings.

| Run | Boot | Host load | Guest RAM free | Guest load | Settings cold start (median) |
|---|---|---|---|---|---|
| old, 36.5, cold | 25.3 s | 10.3 | 678 MB | 13.8 | 308 ms |
| old, 37.2, cold | 39.1 s | 20.2 | 1020 MB | 8.1 | 861 ms |
| tuned, 37.2, first boot ever | 90.4 s | 18.2 | - | - | - |
| tuned, 37.2, cold | 19.5 s | 10.5 | 2039 MB | 11.2 | 517 ms |
| tuned, 36.5, cold | 19.1 s | 12.1 | 2195 MB | 4.8 | 349 ms |
| tuned, 37.2, snapshot resume | 5.7 s / 5.6 s | 10 | 2386 MB | 2.3 | 372 ms |

Caveat: the host was busy throughout. Host load ranged from 10 to 20, because a second emulator (`flywheel_qa_api35`) and several other processes were running. Each row is a single run. Treat differences under about 20% as noise.

### What the numbers say
- **Tuned config:** cold boot is about 25% faster (25.3 s to about 19 s). The guest has 3x the free RAM (about 2.1 GB vs 0.7 GB), and on 36.5 the guest load drops from 13.8 to 4.8. The Settings app is too light to show the RAM benefit. Expect it with real apps and long sessions, where the old 2 GB guest had about 400 MB left after 15 minutes.
- **Emulator 37.2.12 did not help.** At similar host load (10.5 vs 12.1), the tuned AVD on 37.2 had a slower app start (517 vs 349 ms) and more than twice the guest load (11.2 vs 4.8) than on 36.5. The old AVD on 37.2 was slower too, but host load was double during that run, so that pair is confounded. Tentative call: stay on 36.5.11 until a quieter re-test says otherwise.
- **Snapshot resume is the biggest win:** 5.6 s, about the same as the old AVD's 6 s. The cost is disk: a 4 GB guest gives a 3.5 GB `ram.bin`, up from 0.7 GB.
- **Fresh AVDs pay a one-time first boot of about 90 s** (dexopt and setup). It never repeats.

### Disk
Disk space got critically low during testing, and the emulator refused to start with "Not enough space to create userdata partition" (it needs 1.2x the data partition size). Cleanup so far:
- Unused ps16k image: 2.4 GB
- Unavailable iOS simulators
- Gradle 8.10.2, 8.12 and 8.14 caches: 14.4 GB

13 GB is free now. The old AVD grew from 6.7 GB to 8.5 GB over a few cold boots.

## Current setup (after round 2)
- `fast_api35` runs on emulator 36.5.11 through `run-fast-avd.sh` (port 5580). The side-by-side 37.2.12 install has been removed.
- The snapshot was rebuilt on 36.5 with animations off. Three resumes through the script took 7.0 s, 4.9 s and 4.9 s, with host load between 20 and 28. The snapshot stayed valid after all three.
- 15 GB of disk is free.

## Not yet tested
- A re-run on a quiet host (no second emulator), with 3 or more samples per row
- Vulkan / gfxstream paths (`-feature Vulkan`, `-gpu host` vs `swangle`)
- Real app cold start and install time (`adb install`) for one of your apps, not Settings

See `make-fast-avd.sh` for the tuned AVD.
