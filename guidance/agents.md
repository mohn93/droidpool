## Android devices (droidpool)
- Get Android emulators only from droidpool: the `get_device` MCP tool (flavor `clean`, or `signed-in` for Google account / Play Store / purchases), or `droidpool get` on the command line.
- Never run `emulator`, `avdmanager`, or `adb emu kill` yourself, and never create AVDs.
- Always use `adb -s <serial>` with the serial you were given. Never assume `emulator-5554`. Pass the same serial to flutter (`-d <serial>`) and flywheel-qa (`deviceId`).
- Release the device with `release_device` when you finish testing.
- If the pool is full or a base is missing, tell the user. Do not work around it.
