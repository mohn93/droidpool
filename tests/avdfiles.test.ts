import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNED_CONFIG, applyConfig, deviceIni, rewriteHardwareIni } from '../src/avdfiles.ts';

test('applyConfig replaces and appends', () => {
  const out = applyConfig('a=1\nhw.ramSize=2048\n', { 'hw.ramSize': '4096', 'hw.cpu.ncore': '6' });
  const lines = out.split('\n');
  assert.ok(lines.includes('a=1'));
  assert.ok(lines.includes('hw.ramSize=4096'));
  assert.ok(lines.includes('hw.cpu.ncore=6'));
  assert.equal(lines.filter((l) => l.startsWith('hw.ramSize')).length, 1);
  assert.ok(out.endsWith('\n'));
});

test('applyConfig adds trailing newline when missing', () => {
  assert.equal(applyConfig('a=1', { b: '2' }), 'a=1\nb=2\n');
});

test('TUNED_CONFIG has the base keys', () => {
  assert.deepEqual(TUNED_CONFIG, {
    'hw.ramSize': '4096',
    'vm.heapSize': '512M',
    'hw.cpu.ncore': '6',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'host',
    'disk.dataPartition.size': '6G',
    'fastboot.forceFastBoot': 'yes',
    showDeviceFrame: 'no',
    'hw.audioInput': 'no',
  });
});

test('deviceIni', () => {
  assert.equal(
    deviceIni('/h/.droidpool/avd/dev-abc123.avd', 35),
    'avd.ini.encoding=UTF-8\npath=/h/.droidpool/avd/dev-abc123.avd\ntarget=android-35\n',
  );
});

test('rewriteHardwareIni paths and ids', () => {
  const input = [
    'disk.dataPartition.path = /h/.droidpool/avd/../avd/base-clean-35.avd/userdata-qemu.img',
    'disk.cachePartition.path = /h/.droidpool/avd/base-clean-35.avd/cache.img',
    'avd.name = base-clean-35',
    'avd.id = base-clean-35',
    'hw.ramSize = 4096',
    '',
  ].join('\n');
  const out = rewriteHardwareIni(
    input,
    'base-clean-35',
    '/h/.droidpool/avd/base-clean-35.avd',
    'dev-abc123',
    '/h/.droidpool/avd/dev-abc123.avd',
  );
  assert.equal(
    out,
    [
      'disk.dataPartition.path = /h/.droidpool/avd/dev-abc123.avd/userdata-qemu.img',
      'disk.cachePartition.path = /h/.droidpool/avd/dev-abc123.avd/cache.img',
      'avd.name = dev-abc123',
      'avd.id = dev-abc123',
      'hw.ramSize = 4096',
      '',
    ].join('\n'),
  );
  assert.ok(!out.includes('base-clean-35'));
});
