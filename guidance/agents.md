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
