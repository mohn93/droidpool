# Contributing

## Setup

```bash
npm install
```

Node 22.18 or newer runs the TypeScript sources directly; there is no build step.

## Checks

```bash
npm test             # unit tests (node:test), no emulator needed
npm run typecheck    # tsc --noEmit
```

The unit tests use a fake process runner and a temporary `DROIDPOOL_HOME`, so they never touch your real pool or start emulators.

## Smoke test with real emulators

```bash
DROIDPOOL_E2E=1 node scripts/e2e.ts
```

This builds a clean base in a temporary `DROIDPOOL_HOME`, gets two devices, checks that both boot from the snapshot, writes 200 MB in one, and releases both. It reports boot times and the disk freed. It also checks that `~/.android/avd` is unchanged and that no emulator outlives its release. It needs about 24 GB free and takes several minutes. Ports held by other emulators are skipped. Without `DROIDPOOL_E2E=1` it exits immediately.

## Branches

`dev` is the default branch. Open pull requests against `dev`. `main` only receives merges from `dev`.

## Style

- Commit messages, docs, and comments: plain and short, no emoji.
- Add or update tests with every behavior change.
- `docs/how-it-works.md` explains the design. `docs/superpowers/` holds the original design spec, plan, and execution log.
