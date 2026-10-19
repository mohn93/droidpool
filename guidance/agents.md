## Android devices (droidpool)

- Get Android devices only from droidpool: the `get_device` MCP tool, or `droidpool get` on the command line.
- Never run `emulator`, `avdmanager`, or `adb emu kill` yourself.
- Always use `adb -s <serial>` with the serial you were given. Never assume `emulator-5554`.
- Release the device with `release_device` when you finish testing.
- If the pool is full or a base is missing, tell the user. Do not work around it.
