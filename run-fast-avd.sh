#!/bin/zsh
# Launch fast_api35 with fixed flags. First run: cold boots, trims the guest, saves the snapshot.
# Later runs: resume that snapshot without overwriting it.
SDK=~/Library/Android/sdk; ADB=$SDK/platform-tools/adb; NAME=fast_api35; PORT=5580
EMU=$SDK/emulator/emulator   # 36.5.11; 37.2.12 benchmarked slower here (see FINDINGS.md)
SNAP=~/.android/avd/$NAME.avd/snapshots/default_boot/ram.bin
FLAGS=(-avd $NAME -port $PORT -no-boot-anim)   # never change these between runs, or the snapshot is invalidated
A=($ADB -s emulator-$PORT)

if [[ -f $SNAP ]]; then
  $EMU $FLAGS -no-snapshot-save "$@" &
  $A wait-for-device
else
  $EMU $FLAGS "$@" &
  $A wait-for-device
  until [[ "$($A shell getprop sys.boot_completed | tr -d '\r')" == "1" ]]; do sleep 1; done
  $A shell settings put global window_animation_scale 0
  $A shell settings put global transition_animation_scale 0
  $A shell settings put global animator_duration_scale 0
  sleep 30   # let first-boot background work settle before snapshotting
  $A emu avd snapshot save default_boot
  echo "Snapshot saved; next launches resume from it."
fi
