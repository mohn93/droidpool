import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPort } from '../src/ports.ts';
import { loadConfig } from '../src/config.ts';

test('pickPort returns the lowest free even port', () => {
  const cfg = loadConfig({});
  assert.equal(pickPort(cfg, new Set([5620, 5622])), 5624);
});

test('pickPort returns null when exhausted', () => {
  const cfg = loadConfig({});
  const used = new Set<number>();
  for (let p = cfg.portMin; p <= cfg.portMax; p += 2) used.add(p);
  assert.equal(pickPort(cfg, used), null);
});
