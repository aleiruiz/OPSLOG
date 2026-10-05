# G0 gate audit B: OPSLOG `main@8b1b61c187c153c2c24e4cf3d714f8ae7f41051e`

- **Auditor:** independent G0 gate auditor B, model `claude-opus-5-5` (Anthropic, the active provider). I am not the author of #21, #22 or #23. I did not read the other auditor's report for this SHA. I read the earlier reports for 89d3de1 and 940fbdf as background only.
- **Date:** 2026-10-05 (America/Mexico_City).
- **Workspace:** clean checkout `/tmp/claude-0/g0v3-b`, used read-only. `git status --short` was empty at the end.
  - All probes, the Playwright config and the compiled runtime copies lived in a scratch directory outside the repo.
- **Environment:** Node 22.22.0, pnpm 11.25.0, Chromium 1194, and a synthetic MySQL 8.0.45 container bound to loopback (removed afterwards). No AWS, no `.env`, no real data.

## Verdict: **APPROVE** (candidate), with external preconditions stated below

1. **The three blockers from audit B of 89d3de1 are resolved.**
   - B1 (coverage): every production package now has an enforced threshold, and the measured values meet SPECS §9.1.
   - B2 (runtime gates): fixed. I re-ran all four earlier attacks and each one is now rejected.
   - B3 (FND-ORCH deferral): ADR-0008 records the user's decision.
2. **Nothing in the candidate code or configuration is blocking.** I found no exploitable cross-tenant path and no auth bypass in M1.
3. **Two items cannot be resolved inside the repository.** E1 (branch protection) and E2 (AWS) are both recorded honestly in ADR-0008.

   - E2 is acceptable as documented: FND-AWS acceptance explicitly allows "ausencia de acceso registrada como dependencia real".
   - E1 leaves FND-INTEGRATE's "protección de baseline/gates contra cambios del autor" unmet. In my judgment, G0 should be **recorded as passed only after one of these**:
     - the owner configures branch protection or a ruleset on `main` (with `quality` required), or
     - the owner explicitly accepts E1 as an open external block.

   Recording G0 passed without either would conflict with FND-INTEGRATE's "no falsear G0".

**On the FND-ORCH deferral (B3):** the 2026-10-05 decision card cannot be verified from the repository. I treat it as an **attested owner decision**: `docs/adr/0008-g0-gate-audit-and-m1-exception.md:20` records it, and ADR-0008 says it was adopted by the user's direct instruction.

## Commands run (this SHA)

| Command                                                                                       | Result                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                              | OK                                                                                                                                                                                                                                 |
| `pnpm baseline:check`                                                                         | PASS: "12 files across 5 manifests". No file under `docs/baselines` changed since 89d3de1                                                                                                                                          |
| `pnpm lint`                                                                                   | PASS (exit 0, `--max-warnings 0`)                                                                                                                                                                                                  |
| `pnpm format:check`                                                                           | PASS                                                                                                                                                                                                                               |
| `pnpm exec tsc -b`                                                                            | PASS                                                                                                                                                                                                                               |
| `pnpm test:unit` (all coverage thresholds)                                                    | PASS, exit 0. Per-package results are below                                                                                                                                                                                        |
| `pnpm test:integration` against synthetic MySQL 8.0.45                                        | PASS: harness 1/1, tenancy 5/5                                                                                                                                                                                                     |
| Playwright e2e (temporary config outside the repo, Chromium 1194, `retries: 0`, `forbidOnly`) | PASS 9/9                                                                                                                                                                                                                           |
| `pnpm audit --audit-level high`                                                               | PASS (1 low, 3 moderate)                                                                                                                                                                                                           |
| GitHub check-runs for 8b1b61c                                                                 | `quality` = success (job 112025239373, run 37387748869). Every step succeeded, including `pnpm quality` and `pnpm test:e2e`. The raw log download was blocked by the sandbox proxy (403), so I re-ran the commands locally instead |
| `GET branches/main/protection`; `GET rulesets`                                                | 404 "Branch not protected"; `[]`                                                                                                                                                                                                   |

**Coverage measured by the `test:unit` gate (v8: lines / branches / functions):**

| Package                                                      | Lines | Branches | Functions |
| ------------------------------------------------------------ | ----- | -------- | --------- |
| contracts                                                    | 100   | 99.23    | 100       |
| ui                                                           | 100   | 97.29    | 100       |
| domain/tenants                                               | 100   | 100      | 100       |
| persistence/tenancy (`entities.ts` decorators: 0% functions) | 96.2  | 95.84    | 91.02     |
| tools/orchestrator                                           | 100   | 92.73    | 100       |
| domain/identity                                              | 99.74 | 99.55    | 100       |
| platform/auth                                                | 100   | 100      | 100       |
| api/auth                                                     | 100   | 96.42    | 100       |
| worker/base                                                  | 100   | 100      | 100       |
| platform/audit                                               | 94.39 | 94.11    | 100       |
| platform/outbox                                              | 98.92 | 92.55    | 100       |
| infra/queues                                                 | 100   | 100      | 100       |
| api/tenants                                                  | 100   | 100      | 100       |
| harness                                                      | 100   | 100      | 100       |

Every production source directory has an enforced threshold. I checked this against `git ls-files` of all non-test `.ts` sources.

## Per-criterion evaluation (ORCH §7.2 / §8 G0, `canPass(G0)`)

| #   | Criterion                                                         | Result                                      | Evidence                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Candidate frozen (commit, lockfile, migrations, baseline hashes)  | PASS                                        | SHA 8b1b61c; install with the frozen lockfile; `baseline:check` OK; migrations versioned in `packages/persistence/tenancy/src/migrations.ts`                                                                                  |
| 2   | Cumulative inventory and G0 report                                | OPEN (not a candidate defect)               | `docs/audits/G0/2026-10-04-report.md:1` is marked historical and says the current report is "pendiente". The #1–#23 inventory with mergeSHAs still has to be published with the gate record (ORCH §7.2 steps 2 and 5). See N8 |
| 3   | Design system: tokens, theme, stories, keyboard, contrast, axe    | PASS (deferrals recorded)                   | e2e 9/9, including axe WCAG 2.1 A/AA, text-field border contrast of at least 3:1 (new in #23), keyboard focus, 360px reflow and the story scan. Storybook runtime and pixel snapshots are deferred in ADR-0008                |
| 4   | Contracts / traceability                                          | PASS for M0 contracts; honesty caveat (N8)  | Contract tests reach 100/99.23 under the threshold                                                                                                                                                                            |
| 5   | CI really gates (lint, failing test, coverage, MySQL fail-closed) | PASS                                        | See CI integrity below. One residual gap is N2                                                                                                                                                                                |
| 6   | Interoperability                                                  | PASS                                        | `tsc -b` and build succeed across all projects                                                                                                                                                                                |
| 7   | FND-ORCH runtime                                                  | PASS for the G0 scope (deferrals attested)  | All four earlier gate attacks are now rejected. The residual issues are N3–N6. The runtime is a library that nothing wires into dispatch yet                                                                                  |
| 8   | Multi-tenant isolation and M1 security                            | PASS                                        | See the security section below                                                                                                                                                                                                |
| 9   | Baseline/gate protection against author changes                   | **EXTERNAL BLOCK E1**                       | No branch protection, no rulesets, no CODEOWNERS. `integrity.mjs` anchors on itself                                                                                                                                           |
| 10  | DB/AWS/provider viability                                         | E2 acceptable as documented; providers PASS | ADR-0002, `infra/plan/AWS.md`, ADR-0008 (b). Model pins are in `tools/orchestrator/domain.ts:58-65`                                                                                                                           |
| 11  | Required checks green                                             | PASS                                        | `quality` success on 8b1b61c                                                                                                                                                                                                  |
| 12  | Two independent gate audits                                       | This is one of the two                      | ADR-0008                                                                                                                                                                                                                      |
| 13  | Zero blocking findings                                            | PASS                                        | None found in the candidate                                                                                                                                                                                                   |

## 1. Security and multi-tenancy of M1 (verified)

I found no exploitable cross-tenant path or auth bypass.

**Auth**

- `AuthApi.login` accepts only a principal carrying the module-private symbol brand (`packages/platform/auth/src/index.ts:126-136`). JSON input cannot forge it.
- `login` picks the tenant server-side through `resolveActiveTenant` (`apps/api/auth/src/index.ts:30`).
- `authenticate` checks four things:
  - the session hash (`timingSafeEqual`),
  - revocation and expiry,
  - that `authorizationVersion` equals the identity's version,
  - an active membership in the session's tenant (`packages/domain/identity/src/index.ts:531-551`).
- **Invitation takeover is blocked.** Activation rejects a subject that is already linked to another identity, and rejects any subject other than the one already linked (`:244-253`). An invitation that a tenant-B admin issues for tenant-A's identity ID therefore cannot be activated by anyone except that identity's own subject.
- **Recovery does not enumerate accounts.** It runs in the background, is throttled, supersedes older requests, and bumps the version on consume.

**Tenancy**

- The resolver ignores tenant hints in headers, body or query. It derives everything from the hashed session ID, the active tenant, an active membership with a matching version, and a verified location (`packages/persistence/tenancy/src/index.ts:1006-1040`).
- `acquire` accepts only contexts marked in the resolver's WeakSet (`:307-309`, `trusted-context.ts`). `trustContextForTests` is not exported from the package entry point.
- Credentials must match the tenant, database, version and the `opslog_u_` pattern. `TenantScopedRepository` forces `tenantId` after the spread (`:1057-1059`).
- Provisioning is fenced per attempt, with a separate database and credential each time. Attempts are capped and marked `ATTEMPTS_EXHAUSTED`. Suspended tenants are skipped. The idempotency key is bound to a payload hash.
- On real MySQL, `ER_DBACCESS_DENIED` holds between tenants A and B (integration suite, 5/5).

**Outbox and worker**

- Records are keyed by `(tenantId, eventId)` with opaque-ID validation, and an idempotent replay with a conflicting payload is rejected.
- Ack and retry are fenced. The worker refuses suspended or missing tenants before the handler runs.

**Audit**

- Persisted `data` is allow-listed to `attempts`, actor IDs are regex-gated, and error messages are scrubbed.

## 2. Adversarial orchestrator probes

I compiled `tools/orchestrator/{domain,runtime}.ts` from this SHA into a scratch directory and drove the public API directly.

| #      | Attack                                                                                   | Result                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P10    | Fail G0 after G0 and G1 have passed, then lease an M2 task                               | **Rejected.** Gates become `{0: failed, 1: pending, 2: pending}` (earlier B2.1 fixed)                                                                         |
| P11    | Register a late M0 task after G0 passed                                                  | **Rejected.** G0 reopens to pending and M1 is blocked (earlier B2.2 fixed)                                                                                    |
| —      | Pass an empty stage, or restore a passed gate with no completed tasks                    | **Rejected** (`runtime.ts:160-161`, `:273-280`)                                                                                                               |
| P12    | Author acting as gate auditor                                                            | **Rejected**, because two distinct non-author auditors are required                                                                                           |
| P13    | One of the two auditors requests changes                                                 | **Rejected**                                                                                                                                                  |
| P16    | Stale worker completes after its lease was reassigned                                    | **Rejected** (stale fencing token)                                                                                                                            |
| P14    | Gate pass after `handoff` (claude to codex) using pre-handoff candidates                 | **Rejected.** Fail-closed, but see N6                                                                                                                         |
| P1, P2 | Lease M1 when no stage-0 task is registered; lease M2 after G0 when stage 1 has no tasks | **Accepted** (N3)                                                                                                                                             |
| P3     | `register()` a task already `completed` to satisfy a dependency                          | **Accepted** (N4)                                                                                                                                             |
| P4     | Task with `stage: NaN` while G0 has failed                                               | **Accepted** (N4)                                                                                                                                             |
| P5     | `acquire(..., requestedPaths=[])`, then a second task leases the same scope              | **Accepted** (N5)                                                                                                                                             |
| P6     | One task holds `tools/*` while another leases `tools/orchestrator/runtime.ts`            | **Accepted** (N5)                                                                                                                                             |
| P6b    | FND-AWS with the catalogue path `docs/adr/aws*`                                          | Cannot lease `docs/adr/aws-plan.md` ("path outside task scope"). Another task with `docs/adr/**` can lease that file while FND-AWS holds `docs/adr/aws*` (N5) |
| P7     | Reuse one `eventId` for two different tasks                                              | The second completion is silently ignored and the task stays `leased` (N6)                                                                                    |
| P8     | Expired lease still holds paths and blocks `handoff`                                     | Confirmed (N6)                                                                                                                                                |
| P9     | Forged snapshot `{gates: {0: 'passed'}}` with completed or authored tasks but no audits  | Restores, and M1 becomes leasable. The FND-ORCH limitations section (`docs/tasks/FND-ORCH.md:112`) discloses that audit evidence is not part of the snapshot  |
| P15    | Restore with gate status `"banana"`                                                      | Accepted, but it fails closed because it is never `passed`                                                                                                    |
| P17    | Restore leases with an absolute path `/etc`                                              | Accepted without validation (N6)                                                                                                                              |

`grep` shows that nothing outside `tests/orchestrator` instantiates `OrchestratorRuntime`, and `tools/orchestrator` contains no CLI. The accepted cases are therefore latent. They do not make G0 fail, but they must be fixed before the runtime drives real dispatch, together with the persistent store and `simulate` deferred to G1.

## 3. CI and workflow integrity

- `quality.yml` runs on push and pull request with `permissions: contents: read`.
  - Actions are pinned by SHA.
  - The MySQL 8.0.45 service is present and `OPSLOG_TEST_MYSQL_ADMIN_URL` is set.
  - The steps are `pnpm audit`, `pnpm quality` and e2e.
- `quality` chains `baseline:check && lint && format:check && typecheck && test:unit && test:integration && build` with `&&`, so any failure fails the job.
- Every `vitest` invocation in `test:unit` runs with `--coverage.enabled` and thresholds, so coverage really gates.
- Integration tests fail closed when the database URL is unset (verified in the earlier audit; the code is unchanged).
- e2e runs with `retries: 0`, and `forbidOnly` is on in CI.

**Residual integrity gaps (non-blocking):**

- N2 below.
- The workflow and the baseline manifests are not protected (E1). A PR can change `package.json` thresholds, `quality.yml` or `integrity.mjs` together with the files they guard.

## 4. Test strength and documentation honesty

- **Vacuous-test scan.** A heuristic scan of every `*.test.ts` and `*.spec.ts` for tests with no assertion found 4 candidates. All 4 assert through helpers (`expectMonotonicEnqueueIds`, shared expectations), so none is vacuous.
- **Hand-checked samples:**

  - `apps/api/tenants/src/index.test.ts`: tenant-hint injection, revoked or unknown session, suspended tenant.
  - The tenancy unit suite: 181 tests, including a "lost commit acknowledgement" `describe` block (`index.test.ts:1560`) and `ATTEMPTS_EXHAUSTED` (`:1528`, `:1896`).
  - `tests/orchestrator/runtime.test.ts` (17 tests).

  The assertions are behavioural, not snapshot padding.

- **Gap in honesty:** see N7 and N8.

## Blockers

None in the candidate.

## External blocks (recorded honestly in ADR-0008 (a) and (b), `docs/adr/0008-g0-gate-audit-and-m1-exception.md:21`)

- **E1. Branch protection.** `main` is unprotected (API 404) and has no rulesets. FND-INTEGRATE's "protección de baseline/gates contra cambios del autor" and SPECS §9.2's trusted evidence are unmet until an admin acts.
  - Under ORCH §7.2 step 8 (coverage of all applicable requirements), I recommend that the owner either configure protection or explicitly accept E1 before G0 is recorded as `passed`.
- **E2. AWS viability.** Deferred by ADR-0002 and honestly stated as having no inventory. It is acceptable for G0 under the FND-AWS acceptance wording. It must stay listed as pending.

## Non-blocking findings (verified)

**N1 (Medium). Coverage floor is below SPECS §9.1 for domain, authorisation and isolation code.**

- `package.json:13`, `packages/persistence/tenancy/package.json:12` and `packages/domain/tenants/package.json:12` enforce 90/85.
- SPECS §9.1 (`SPECS.md:303`) requires 95 lines / 90 branches for domain, authorisation, isolation and workflows.
- Today's measured values meet 95/90 for identity, platform/auth, api/auth, tenancy, domain/tenants and outbox, so the requirement is met but not enforced. A regression to 91/86 would pass CI.
- platform/audit is at 94.39 lines.
- Raise these thresholds before G1.

**N2 (Low-Med). No catch-all test run.**

- `test:unit` names each package explicitly (`package.json:13`), so a new package's tests would not run until the script is edited.
- There is also no "no drop on modified code" check (SPECS §9.1).
- Add a guard that fails when a workspace package has tests that no script runs.

**N3 (Low-Med). Runtime treats an unknown earlier gate as open.**

- `runtime.ts:71-73` and `:163-165` use `gates.has(stage) && …`. Probes P1 and P2 show M1 or M2 can be leased when the earlier stage has no registered tasks. The test at `tests/orchestrator/runtime.test.ts:284` ("skips stages without tasks") makes this deliberate.
- This departs from the literal `canStart(Mn) = G(n-1).passed` in ORCH §7.2 and depends on the catalogue being complete.
- Require an explicit gate per catalogue milestone.

**N4 (Low). `register()` trusts caller-supplied state.**

- It accepts `status: 'completed'`, which satisfies dependencies without any lease or completion (P3, `runtime.ts:29-45`, `:74-76`).
- It accepts non-integer stages: `NaN` skips every gate check (P4).
- Validate `stage` as a non-negative integer and force new tasks to `planned` or `ready`. Only `restore` should rebuild other states.

**N5 (Medium for the future dispatcher). Path locking ignores glob syntax and empty requests.**

- `pathMatches`/`pathsOverlap` (`runtime.ts:288-308`) handle only a trailing `/**`. Single `*` or mid-path globs are compared literally.
- The ORCH §8 catalogue itself uses `docs/adr/aws*`, `docs/runbooks/inventory*`, `.github/workflows/quality*` and `docs/baselines/integrity*`. Probe P6b shows FND-AWS cannot lease its own files while another task can take them.
- `requestedPaths: []` produces a lease that holds nothing (P5).
- This undermines the "doble asignación" acceptance case once dispatch is real.

**N6 (Low). Carried over from the 89d3de1 audit, still present.**

- `complete` deduplicates `eventId` globally and before the fencing check (`runtime.ts:123`, P7).
- Expired leases keep their paths and block `handoff` (`runtime.ts:47`, `:80-87`, P8).
- `restore` does not validate lease paths against scope or overlap (P17), nor gate status values (P15).
- After `handoff`, prior-provider candidates can no longer pass a gate (`runtime.ts:146,150`, P14). This conflicts with ADR-0007's rule to preserve evidence by SHA and model.
- Some of these are disclosed in `docs/tasks/FND-ORCH.md:112`. That text calls them "aceptadas para G0". As auditor B, I accept them as non-blocking for G0 because the runtime is not wired, and require them to be fixed with the G1 orchestrator work.

**N7 (Low, doc). Stale provider statements.**

- `docs/tasks/FND-ORCH.md:97` still says "solo Codex está activo en esta ronda … Claude queda inactivo", which contradicts CLAUDE.md and the current Claude-run G0.
- The runtime constructor defaults to `'codex'` (`runtime.ts:23`).
- `AGENTS.md:18` still says "sin runtime/CI implementados".

**N8 (Low, doc). Report and traceability gaps.**

- `docs/adr/0008-g0-gate-audit-and-m1-exception.md:8` says the 776abce review report is "en `docs/audits/G0/`", but only the historical `2026-10-04-report.md` is there.
- `docs/traceability/FND-CONTRACTS.md:3` is still pinned to SPEC-1.1 and `2cfb28a` and does not map M1 code.
- Publish the G0 report for this candidate with the cumulative #1–#23 inventory and mergeSHAs.

**N9 (Low). M1 items that remain open and are disclosed:**

- `TenantControlPlane.provision` has no authorisation check (`apps/api/tenants/src/index.ts:18-20`). There is no HTTP route yet.
- The last-admin rule is not enforced in the identity store (`packages/domain/identity/src/index.ts:147-150`).
- Outbox `payload` is stored without sanitisation (`packages/platform/outbox/src/index.ts:109`).
- Production code deep-imports across packages (`apps/api/auth/src/index.ts:1-9`), and no lint rule enforces module boundaries.
- `scrub`'s array and object branches are dead code (`packages/platform/audit/src/index.ts:73-77`; they are the uncovered lines).
- The lost-acknowledgement path is covered only by unit tests. `docs/tasks/CORE-TENANCY-M1-20261004.md:101` asked for an integration test before merge, and none exists in `mysql.integration.test.ts`.

## Conditions for recording G0 as passed

1. A second independent approving audit on this same SHA (ADR-0008).
2. The owner resolves or explicitly accepts E1; E2 stays listed as pending.
3. The gate report is published in `docs/audits/G0/` with the cumulative inventory (N8).
4. N1, N3–N6 are tracked as G1-bound remediation, together with the FND-ORCH deferrals in ADR-0008.
