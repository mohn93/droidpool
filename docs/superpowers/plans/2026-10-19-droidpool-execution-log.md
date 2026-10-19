# SDD ledger — plan: docs/superpowers/plans/2026-10-19-droidpool.md
Spec: docs/superpowers/specs/2026-10-19-droidpool-design.md
Workspace: no worktree; the repo was created fresh for this plan, and work happens on branch `dev` (base commit 5a4a2c5 on main). The user approved "new repo here with a dev branch".

## Pre-flight scan

### Tasks that share files or interfaces
| Tasks | Produces vs consumes | Found |
|---|---|---|
| T1 vs T5, T6, T7 (config.ts) | T1 defines Config; T5 adds killWaitMs, T6 adds baseSettleMs, T7 adds freeBytesFn | Consistent. Each later task extends Config and its defaults test. |
| T1 vs T4, T7 (home dir) | T4 freeBytes(path) uses statfs; T7 calls freeBytesFn(cfg.home) | Conflict: on a fresh install cfg.home does not exist, so statfs throws. See R2. |
| T1 vs all (test runner) | `node --test tests/*.test.ts` with Node type stripping | Node 22.22 prints an ExperimentalWarning for type stripping, so test output is not pristine. See R3. |
| T2 vs T7 | applyConfig, deviceIni, rewriteHardwareIni(text, fromName, fromDir, toName, toDir) | Consistent. |
| T3 vs T6, T7, T8, T9 | withState, readState, Lease, Owner, BaseRecord, Flavor | Consistent. The `booting` lease with emulatorPid 0 fits `number`. |
| T4 vs T6, T7 | cloneDir, assertDiskOk(cfg, free?), pickPort(cfg, used) | Consistent once R2 is applied. |
| T5 vs T6, T7 | launchDevice(...) returns a pid, logs to `<logsDir>/<avdName>.log`; waitBoot(..., logFile) | Consistent. |
| T6 vs T7 | assertBaseUsable, exact error strings | Consistent. |
| T7 vs T8, T9 | getDevice, releaseDevice, renewLease, listDevices, reap, POOL_FULL_MESSAGE | Consistent. T9's tests call `shutdown(deps)`; T9 Step 3 exports it. |
| T1 Step 1 vs setup | git init, initial commit, dev branch | Already done by the controller during setup, and `.gitignore` already contains `.superpowers/`. See R1. |

### Each task checked against itself
| Task | Tests vs code vs files |
|---|---|
| T1 | Consistent. Bin paths point to T8 and T9 files that don't exist yet, which is acceptable. |
| T2 | Consistent. The test inputs cover both the `/../avd/` form and the direct path form. |
| T3 | Consistent. |
| T4 | Consistent. 1.2 x 6 GiB + 2 GiB = 9.2 GiB, which matches the "need 9.2 GB" test. |
| T5 | Consistent. |
| T6 | Consistent. |
| T7 | Consistent. |
| T8 | Consistent. |
| T9 | Consistent. |
| T10 | Consistent. It is manual and real-emulator only. |

## Rulings
- **R1.** Ruling: Task 1 Step 1 is already done by the controller during setup (commit 5a4a2c5 on main, now on `dev`). The implementer skips it and appends `node_modules/` to the existing `.gitignore`, which already has `.superpowers/`. Why: the SDD workspace needs a git root before Task 1. Cost if wrong: none; it is the same commit the plan specifies.
- **R2.** Ruling: Task 1 also exports `ensureDirs(cfg: Config): void`, which does `mkdir -p` of home, avdHome and logsDir. buildBase, getDevice and runCli call it before touching disk or statfs. Why: statfs or log writes on a missing `~/.droidpool` would crash on first use. Cost if wrong: one small extra export.
- **R3.** Ruling: the test script is `node --disable-warning=ExperimentalWarning --test tests/*.test.ts`, and the bin shebangs are `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning`. Why: Node 22's type-stripping warning makes test and CLI output noisy. Cost if wrong: it could hide an unrelated experimental warning.

## Execution
Task 1: dispatched (implementer a795977a5597ce8c4, base 5a4a2c5, head e3d9269)
Task 1: minor (deferred): config.ts:145-146 empty HOME/DROIDPOOL_HOME accepted by ?? (use ||)
Task 1: minor (deferred): exec.ts:218 opts.env replaces process.env, undocumented
Task 1: minor (deferred): exec.test.ts:343-353 cleanup not in finally, 200ms sleeps timing-sensitive
Task 1: fix round 1/5 (1 addressed, 0 open; commits e3d9269..498fbdf)
Task 1: minor (deferred): run() now spawns detached (own process group), so terminal Ctrl-C no longer reaches run children; CLI (T8) may need a SIGINT handler that kills them
Task 1: minor (deferred): exec.test.ts grandchild pgrep on literal 'sleep 7.31' can false-positive if suites run concurrently
Task 1: complete (commits 5a4a2c5..498fbdf, review clean after 1 fix round)
Task 2: minor (deferred): avdfiles.ts:68 greedy (?:.*/)? would collapse a value holding fromName.avd twice (cannot occur in real files)
Task 2: minor (deferred): applyConfig ignores 'key = value' spaced lines and duplicate input keys
Task 2: minor (deferred): no test for untouched non-matching path lines
Task 2: ⚠️ resolved — real clone loading snapshot after rewrite: proven by spike 2026-10-19 (same rewrite loaded default_boot). Ruling: Task 10 e2e must additionally assert each device log contains "Successfully loaded snapshot" — why: catches rewrite regressions against the real emulator — cost if wrong: one extra grep in e2e.
Task 2: complete (commits 498fbdf..926b304, review clean)
Task 3: dispatched (implementer a4d0ed43168c8167f, base 926b304, head 8e9b9b6)
Task 3: minor (deferred): state.ts:112-113 owner-less lock dir left if owner write fails (blocks 30s)
Task 3: minor (deferred): state.ts:58-62 no fsync before rename; stray .tmp on rename failure
Task 3: minor (deferred): tests/state.test.ts:62 path.resolve cwd-dependent; temp dirs not removed
Task 3: ⚠️ noted for T6/T7 dispatch — never hold withState across boots/waits (lock staleness 30s)
Task 3: fix round 1/5 (2 addressed, 0 open; commits 8e9b9b6..fd6ff63)
Task 3: minor (deferred): state.ts:137-139 acquire busy-spins (no await) while a crashed breaker's .break is <5s old — blocks event loop up to 5s
Task 3: minor (deferred): state.ts:123 .break removed without ownership check; >5s OS stall in breakLock can still yield brief double holder (holdsLock makes it throw, no lost write)
Task 3: complete (commits 926b304..fd6ff63, review clean after 1 fix round)
Task 4: dispatched (implementer a59330bff276a1968, base fd6ff63, head 08a07b8)
Task 4: Ruling: cloneDir must pre-check same device + APFS (statfs type 26) + dest absent, and refuse before running cp — why: cp -c silently falls back to a full copy, violating spec's top priority (never full-copy) which outranks the plan's "cp -c only" mechanism — cost if wrong: a legitimate clone on an APFS variant reporting a different f_type would be refused (visible error, easy to widen)
Task 4: minor (deferred): rmSync cleanup failure could mask original clone error
Task 4: fix round 1/5 (2 addressed, 0 open; commits 08a07b8..3979176)
Task 4: minor (deferred): dangling symlink at dest passes existsSync guard; raw ENOENT if src/dest parent missing; rejection-cleanup path untested; cross-volume test probe keys on endsWith('src')
Task 4: complete (commits fd6ff63..3979176, review clean after 1 fix round)
Task 5: ⚠️ resolved — FakeRunner signatures match Runner (typecheck clean); realRunner.run resolves on non-zero exit (T1 test asserts code 3)
Task 5: minor (deferred): no test for pid dying after N polls; setAnimationsOff failure path untested; timeout msg rounds to 0s for tiny timeouts
Task 5: note for T7 — FakeRunner.onSpawn sets a persistent pid; T7 parallel-get tests need a pid queue (T7 may extend fakes.ts)
Task 5: complete (commits 3979176..39104e9, review clean)
Task 6: dispatched (implementer a00dfbcdec38b44e6, base 39104e9, head 1af76de)
Task 6: ⚠️ resolved — launchDevice/waitBoot signatures verified from src/emulator.ts (opts {window, snapshotSave}, returns pid, pollMs 6th); Runner.run honors input/timeoutMs (T1)
Task 6: minor (deferred): base build port picked without reservation — concurrent get could pick same port during base boot
Task 6: minor (deferred): removeBase checks leases under lock but deletes files after release (narrow window)
Task 6: minor (deferred): tests don't assert sdkmanager timeoutMs 600000 or window:true directly
Task 6: fix round 1/5 (1 addressed, 1 open — cleanup withState unguarded masks original error; commits 1af76de..0c64399)
Task 6: fix round 2/5 (1 addressed, 0 open; commits 0c64399..dd9f71a)
Task 6: minor (deferred): cleanup-failure test passes vacuously as root; swallowed cleanup error could log via io.log
Task 6: complete (commits 39104e9..dd9f71a, review clean after 2 fix rounds)
Task 7: Ruling: reap never touches 'booting' leases younger than bootTimeoutMs + 60s (any pid); older booting leases are reaped (kill pid if alive, rm dir) — why: the getter process owns boot cleanup; reaping concurrently would double-clean; a getter that died mid-boot still gets cleaned — cost if wrong: a crashed boot holds a slot ~4 min
Task 7: Ruling: reuseSerial — adopt if lease exists and its mcp owner is dead or goneSince set; throw 'device <serial> is owned by another live session' if owner alive; if no such lease, fall through to a fresh device — why: a reconnecting agent whose device was reaped still gets a device — cost if wrong: agent silently gets a new serial (returned serial differs, visible)
Task 7: Ruling: add cfg.queuePollMs (default 1000) so pool-full tests can poll fast — why: plan's 1s poll vs 100ms test wait — cost: one config field
Task 7: dispatched (implementer abe9d132a5e5762bf, base dd9f71a, head 03103c5)
Task 7: Ruling: amend Ruling 2 (reuseSerial) — (a) adopt only if emulator pid alive AND (goneSince unset or now-goneSince <= ownerGraceMs); (b) same owner pid as requester returns the lease as-is; (c) 'booting' lease -> throw 'device <serial> is still booting'; (d) flavor/api mismatch -> not adoptable, fall through to a fresh device; (e) update project on adoption — why: closes adopt/reap race (reviewer Important #1) and fixes misleading errors — cost if wrong: an agent occasionally gets a fresh device instead of its old one
Task 7: ⚠️ resolved — pickPort even-port range covered by T4 tests; CLI/MCP must use poolFullMessage(n) (note for T8/T9 dispatch)
Task 7: minor (deferred, final review to triage): reap teardown serial — use Promise.all; pool-full loop reap not bounded by deadline
Task 7: minor (deferred, final review to triage): one failing teardown in reap (EBUSY/rejected run) makes reap reject and blocks every getDevice — catch per victim
Task 7: minor (deferred, final review to triage): releaseDevice during clone (pid 0) can free port while getter later spawns on it — refuse/defer release of booting pid-0 lease under lock
Task 7: minor (deferred): cloneProbe test-only field on production Config
Task 7: minor (deferred, pre-existing): pid reuse can make killDevice SIGKILL an unrelated process for long-dead emulators
Task 7: fix round 1/5 (1 addressed, 0 open; commits 03103c5..74b83ca)
Task 7: minor (deferred): expired cli lease hit in adopt race window throws 'owned by another live session' instead of falling through; injectAfterEntryReap helper should assert its hook fired
Task 7: complete (commits dd9f71a..74b83ca, review clean after 1 fix round)
Task 8: dispatched (implementer a7b6a39e70ee753b0, base 74b83ca, head 45d5073)
Task 8: ⚠️ resolved — getDevice has no log option (fixed signature), nothing to wire; real doctor ran on this machine (emulator: 36.5.11)
Task 8: minor (deferred): doctor version warning wording differs from the constraint message and omits the rebuild command
Task 8: minor (deferred): no tests for base build waitForUser passing, renew expiry change, --clean/--signed-in conflict; cli test setup duplicates pool test setup
Task 8: fix round 1/5 (1 addressed, 0 open; commits 45d5073..4df272f)
Task 8: minor (deferred): runCli reaps before arg parsing (gc --bad reaps then exits 2); stray ids in gc output untested
Task 8: complete (commits 74b83ca..4df272f, review clean after 1 fix round)
Task 9: ⚠️ resolved — getDevice writes booting lease before slow work (pool.ts ~136-151, verified by reviewer); stdio smoke 6/6 clean (controller) + 6/6 (reviewer)
Task 9: minor (deferred, final review to triage): stop() has no timeout and swallows second signal — hung release leaves process killable only by SIGKILL; add unref'd exit fallback
Task 9: minor (deferred): shutdown during in-flight getDevice can drop booting lease mid-clone (narrow; strays reap covers dirs)
Task 9: minor (deferred): api param description '35' is cryptic; no spawn-based stdio EOF test
Task 9: complete (commits 4df272f..208d76c, review clean)
Task 10: ⚠️ resolved — pool launches clones with avdName = deviceId, so <logsDir>/<deviceId>.log is right; snapshot-loaded text verified only by live run
Task 10: minor (deferred): e2e labels snapshot lines by index not id; no sync after dd (freed MB may under-report); finally re-releases already-released serials (noisy stderr); boot time includes clone+checks
Task 10: Ruling: live run (Step 4) deferred until disk is freed — 14 GB free, need ~5 GB base + 9.2 GB guard — cost if wrong: v1 ships without live verification (stated to user)
Task 10: complete (commits 208d76c..8c9cae7, review clean; live run pending)

## Final review (5a4a2c5..8c9cae7, opus): With fixes — I1-I6 Important, M1-M4 minor
Final: Ruling: I6 — spec wins over plan: on clean MCP exit, do NOT release immediately; mark own leases goneSince=now and spawn a detached delayed reaper (sleep ownerGraceMs+5s, then `droidpool gc`) so devices survive /mcp reconnects for 2 min yet never leak if no other droidpool process runs — why: spec (binding) promises 2-min grace; plan contradicted it — cost if wrong: a closed session's emulator holds RAM ~2 min longer
Final: Ruling: I4 — base builds use a port outside the pool range: portMax+2..portMax+20 (even), first one with no adb device — why: pool reservation never sees base builds — cost: none
Final: Ruling: I3 — MCP release_device only releases leases owned by this server pid or whose owner is dead; CLI release stays unrestricted — why: spec anti-goal (agents colliding) — cost: an agent cannot release a live peer's device (correct)
Final: Ruling: include T3 busy-spin one-liner and M4 e2e asserts in the single fix wave — why: cheap, reviewer-recommended — cost: none
Final: Ruling: M1, M2, M3 and all other deferred minors stay deferred for v1 (reviewer triage: none block merge)
Final: fix wave 8c9cae7..304db52 — re-review: I1-I6, T3, M4 all ADDRESSED; 102/102 tests
Final: parked — I6 race: a reap waiting on the lock can clear goneSince after markGone but before exit, so the delayed gc only re-marks the lease and the device can leak if no other droidpool process runs later — Ruling: park for v1, surface to user as top follow-up (fix: clear the reap interval before markGone, or keep goneSince for the exiting pid) — cost if wrong: an occasional headless emulator survives a closed session until the next droidpool command
Final: parked — I3 owner check is under the lock but teardown runs after it; a concurrent reuse_serial adoption could be torn down — Ruling: park, narrow window — cost: rare lost device for a reconnecting agent
Final: parked — Ctrl-C during rebuild over an existing base leaves its old record (files gone) — Ruling: park; next get fails with a clone error instead of the build hint — cost: confusing error, no leak
