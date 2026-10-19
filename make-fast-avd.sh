#!/bin/zsh
# Creates a tuned AVD "fast_api35" and a launcher that always uses identical flags
# (so the Quickboot snapshot stays valid).
set -e
SDK=~/Library/Android/sdk
IMG="system-images;android-35;google_apis;arm64-v8a"   # no Play Store
NAME=fast_api35

$SDK/cmdline-tools/latest/bin/sdkmanager "$IMG"
echo no | $SDK/cmdline-tools/latest/bin/avdmanager create avd -n $NAME -k "$IMG" -d pixel_7 --force

CFG=~/.android/avd/$NAME.avd/config.ini
set_cfg() { grep -q "^$1=" $CFG && sed -i '' "s|^$1=.*|$1=$2|" $CFG || echo "$1=$2" >> $CFG; }
set_cfg hw.ramSize 4096
set_cfg vm.heapSize 512M
set_cfg hw.cpu.ncore 6
set_cfg hw.gpu.enabled yes
set_cfg hw.gpu.mode host
set_cfg disk.dataPartition.size 6G
set_cfg fastboot.forceFastBoot yes
set_cfg showDeviceFrame no
set_cfg hw.audioInput no

echo "Created $NAME. Run ./run-fast-avd.sh once to build the snapshot."
