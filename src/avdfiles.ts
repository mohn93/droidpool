export const TUNED_CONFIG: Record<string, string> = {
  'hw.ramSize': '4096',
  'vm.heapSize': '512M',
  'hw.cpu.ncore': '6',
  'hw.gpu.enabled': 'yes',
  'hw.gpu.mode': 'host',
  'disk.dataPartition.size': '6G',
  'fastboot.forceFastBoot': 'yes',
  showDeviceFrame: 'no',
  'hw.audioInput': 'no',
};

// config.ini is written as key=value with no spaces around '='.
export function applyConfig(configIni: string, values: Record<string, string>): string {
  const lines = configIni.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq);
      if (remaining.has(key)) {
        const value = remaining.get(key);
        remaining.delete(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  return out.join('\n') + '\n';
}

export function deviceIni(avdDir: string, api: number): string {
  return `avd.ini.encoding=UTF-8\npath=${avdDir}\ntarget=android-${api}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// hardware.ini is written as `key = value` (with spaces). Only path values whose
// directory component is `<fromName>.avd`, plus avd.name and avd.id, are rewritten.
export function rewriteHardwareIni(
  text: string,
  fromName: string,
  _fromDir: string,
  toName: string,
  toDir: string,
): string {
  const pathRe = new RegExp(`^(\\S[^=]*?\\s=\\s)(?:.*/)?${escapeRegExp(fromName)}\\.avd(?=/|$)`);
  return text
    .split('\n')
    .map((line) => {
      if (/^avd\.name = /.test(line)) return `avd.name = ${toName}`;
      if (/^avd\.id = /.test(line)) return `avd.id = ${toName}`;
      return line.replace(pathRe, (_m, prefix: string) => `${prefix}${toDir}`);
    })
    .join('\n');
}
