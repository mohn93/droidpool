# Research notes

Experiments from before droidpool existed, kept for reference.

- `FINDINGS.md`: measurements of Android emulator boot, snapshot, RAM, and CPU behavior on an M1 Max, and why the iOS Simulator feels faster.
- `make-fast-avd.sh`, `run-fast-avd.sh`: scripts that create and launch a single tuned AVD named `fast_api35`.

Do not use the scripts alongside droidpool. They write to `~/.android/avd` and use port 5580, outside droidpool's control. droidpool's tuned settings live in `src/avdfiles.ts`.
