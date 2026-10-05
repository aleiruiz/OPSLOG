# G0 gate audit B — OPSLOG `main@89d3de10cdebe22c001443d7dd0585374f4f9029`

- Auditor: independent G0 gate auditor B, model `claude-opus-5-5` (Anthropic, active provider). Not the author of #21/#22; I did not read other auditors' reports.
- Date: 2026-10-05 (America/Mexico_City)
- Workspace: clean checkout `/tmp/claude-0/g0v2-b`, read-only. `git status` was clean at the end. All probes and configs lived outside the repo.
- Environment: Node 22.22.0, pnpm 11.25.0, MySQL 8.0.45 container (synthetic, loopback, removed afterwards), Chromium 1194. No AWS, no `.env`, no real data.

## Verdict: **REQUEST CHANGES**

The CI and quality commands are green, and the M1 security core holds up well. G0 still cannot pass, for three reasons:

1. SPECS §9.1 coverage bar is not enforced for most production packages and is not met in several. This includes the merged M1 auth and tenancy code, which ADR-0008 puts inside the G0 cumulative scope.
2. The FND-ORCH runtime does not enforce cumulative gates. I broke it in four ways, so its "gates acumulativos" claim is false.
3. Some FND-ORCH acceptance criteria for M0 were deferred to G1 by the author session, not by the auditors or the user.

Two external blocks remain open and are not met: branch protection is missing, and AWS viability is deferred.

## Commands run (this SHA)

| Command                                                                                                   | Result                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                                          | OK                                                                                                                                                                                               |
| `pnpm baseline:check`                                                                                     | PASS: "12 files across 5 manifests". `git log` shows each baseline file and manifest was touched only by its creating commit.                                                                    |
| `pnpm lint`                                                                                               | PASS (0 warnings)                                                                                                                                                                                |
| `pnpm format:check`                                                                                       | PASS                                                                                                                                                                                             |
| `pnpm typecheck` (`tsc -b`) / `pnpm build`                                                                | PASS                                                                                                                                                                                             |
| `pnpm test:unit`                                                                                          | PASS. contracts 15 tests (100/99.23 br), ui 13 (100/97.29 br), axe 2, domain-tenants 2, tenancy unit 14, orchestrator 10 (99.05 L / 87.75 br), M1 platform suite 73 (**no coverage**), harness 4 |
| `pnpm test:integration` (MySQL 8.0.45 synthetic)                                                          | PASS: harness 1, tenancy 5. It fails closed when `OPSLOG_TEST_MYSQL_ADMIN_URL` is unset (verified).                                                                                              |
| Playwright e2e (temp config outside repo, Chromium 1194)                                                  | PASS 8/8, retries 0                                                                                                                                                                              |
| `pnpm audit --audit-level high`                                                                           | PASS (1 low, 3 moderate)                                                                                                                                                                         |
| ESLint probe with `no-floating-promises`, `no-misused-promises`, `no-explicit-any` (temp config, deleted) | 0 findings                                                                                                                                                                                       |
| GitHub check-runs for 89d3de1                                                                             | `quality` = success (run 37383508004)                                                                                                                                                            |
| `GET branches/main/protection`; `GET rulesets`                                                            | 404 "Branch not protected"; `[]`                                                                                                                                                                 |

## Per-criterion evaluation (ORCH §7.2 / §8 G0, canPass(G0))

| #   | Criterion                                                                                 | Result                                     | Evidence                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Candidate frozen (commit, lockfile, migrations, baseline hashes)                          | PASS                                       | SHA 89d3de1; frozen lockfile install; baseline:check OK; migrations versioned in `packages/persistence/tenancy/src/migrations.ts`                                                                                                                                                  |
| 2   | Cumulative inventory (all taskIDs/PRs/mergeSHAs, FR/BR/NFR, deferrals)                    | **FAIL (non-blocking alone)**              | The only G0 report is marked historical and covers PRs up to #9 (`docs/audits/G0/2026-10-04-report.md:1`). Nothing lists #15–#22 with mergeSHAs. The traceability matrix is still pinned to SPEC-1.1 / `2cfb28a` and does not map M1 code (`docs/traceability/FND-CONTRACTS.md:3`) |
| 3   | Design system: tokens, theme, stories, keyboard, contrast, axe, snapshots                 | PASS (with recorded deferrals)             | UI coverage 100/97; real-browser axe WCAG 2.1 A/AA, keyboard focus, 360px reflow and story scan all pass. Pixel snapshots and the Storybook runtime are explicitly deferred (`docs/design/FND-DS.md`, "Escalas…" section)                                                          |
| 4   | Contracts / traceability                                                                  | PASS for M0 contracts; partial for honesty | Contract tests pass with threshold. The matrix's "Implementación" column holds `index.test.ts (synthetic)` while its "Prueba" column says "not CI-verified", although those tests run in CI (`docs/traceability/FND-CONTRACTS.md` FR-001…FR-170 rows)                              |
| 5   | CI real and gating quality (FND-REPO: fails on lint, failing test, insufficient coverage) | **FAIL**                                   | Lint, tests and MySQL fail closed. Coverage does not gate most production packages (B1)                                                                                                                                                                                            |
| 6   | Interoperability (theme + contracts + runtime together)                                   | PASS                                       | `tsc -b` across 15 projects; build OK                                                                                                                                                                                                                                              |
| 7   | Orchestrator runtime (FND-ORCH acceptance)                                                | **FAIL**                                   | B2, B3                                                                                                                                                                                                                                                                             |
| 8   | Planned isolation (multitenancy)                                                          | PASS for G0 scope                          | Real MySQL A/B `ER_DBACCESS_DENIED` probes (`mysql.integration.test.ts:173,569,575`), trusted-context WeakSet, `opslog_u_`/`opslog_control_` account guards, loopback-only harness                                                                                                 |
| 9   | Baseline / gate protection against author changes (FND-INTEGRATE)                         | **EXTERNAL BLOCK**                         | `integrity.mjs` is self-anchored: a PR can edit a file and its manifest together. There is no CODEOWNERS and `main` is not protected (API 404)                                                                                                                                     |
| 10  | DB/AWS/provider viability                                                                 | **EXTERNAL BLOCK (AWS)**; provider PASS    | ADR-0002 defers AWS. `infra/plan/AWS.md` honestly says it has no inventory. Provider pins are encoded in `tools/orchestrator/domain.ts:46-53`                                                                                                                                      |
| 11  | Required checks green on candidate                                                        | PASS                                       | `quality` success on 89d3de1                                                                                                                                                                                                                                                       |
| 12  | Two independent gate audits                                                               | Pending (this is one)                      | ADR-0008                                                                                                                                                                                                                                                                           |
| 13  | Zero blocking findings                                                                    | **FAIL**                                   | B1–B3                                                                                                                                                                                                                                                                              |

## Blockers

**B1. SPECS §9.1 coverage bar is neither enforced nor met for most production packages (Medium-High)**

- `package.json:13` runs `vitest run packages/domain/identity packages/platform/auth apps/api/auth apps/worker/base packages/platform/audit packages/platform/outbox infra/queues` with no `--coverage` thresholds.
- `packages/domain/tenants/package.json:12` and `packages/persistence/tenancy/package.json:12` have no thresholds either.
- `apps/api/tenants` has no tests at all.
- The harness threshold is 80% lines only.
- Measured on this SHA (v8, unit tests; tenancy also with integration):

| Package                                     | Lines    | Branches | Functions |
| ------------------------------------------- | -------- | -------- | --------- |
| `packages/domain/tenants`                   | 48.3     | 50       | 27.3      |
| `packages/persistence/tenancy` (unit+MySQL) | 93.0     | **79.6** | 93.6      |
| `packages/domain/identity`                  | 99.0     | **83.4** | 100       |
| `packages/platform/audit`                   | 94.4     | **79.5** | 100       |
| `packages/platform/auth`                    | **88**   | 100      | **75**    |
| `apps/api/auth`                             | **88.6** | 86.4     | **85.7**  |
| `apps/api/tenants`                          | **0**    | 0        | 0         |

- Auth, authorisation and isolation code needs 95/90 under SPECS §9.1. FND-REPO acceptance ("pipeline falla … ante cobertura insuficiente") is therefore unmet, and #22's "coverage gate" covers only ui, contracts and orchestrator.
- Untested critical paths in `packages/persistence/tenancy/src/index.ts`:
  - attempts-exhausted branch (797–810)
  - lost-commit-ack `attemptOutcome` succeeded/unknown (876–883)
  - the lease-heartbeat renewal timer (894–907)
- `docs/tasks/CORE-TENANCY-M1-20261004.md:98` itself made a lost-ack integration test a pre-merge condition. No such test exists in either unit or integration tests (grep for `ATTEMPTS_EXHAUSTED`/lost-ack: none).
- Fix: add per-package thresholds for every production package, at 95/90 for auth/tenancy/identity/authorisation, plus tests for these paths.

**B2. The orchestrator runtime does not enforce cumulative gates (Medium; FND-ORCH acceptance "gate pendiente/fallido … queda bloqueada", ORCH §7.3)**
I reproduced each case against the compiled `tools/orchestrator/runtime.ts` built from this SHA:

1. **Earlier gate invalidation is ignored.** With G0 and G1 passed, `setGate(0,'failed')` still lets a stage-2 task be leased. `acquire` checks only `gates.get(stage-1)` (`runtime.ts:117-118`), so it breaks `canStart(Mn) … no invalidated previous gate`.
2. **Late registration does not reopen a gate.** After G0 passed, `register([stage-0 task])` keeps G0 `passed` (`runtime.ts:89`), and stage-1 tasks keep dispatching while M0 work is `ready`.
3. **An empty stage passes vacuously.** `setGate(0,'passed',[])` with no stage-0 tasks succeeds (`runtime.ts:197-208`), and the same holds for `restore()` of a snapshot `{gates:{0:'passed'}, tasks:[stage-1]}` (`runtime.ts:231-242`, no consistency validation). M1 is then leasable.
4. **`setGate(..., 'passed')` needs only one per-PR audit per task.** There is no model of gate audits (two independent auditors), integrated-candidate checks or blocking findings, so `canPass(Gn)` from ORCH §7.2 is not implemented.

`docs/tasks/FND-ORCH.md:101` claims the runtime "cubre con pruebas unitarias … gates acumulativos". That claim is inaccurate.

**B3. FND-ORCH acceptance for M0 was deferred to G1 without authority (process, Medium)**

- `docs/tasks/FND-ORCH.md:99-110` lists acceptance items that are "no construidos o probados" and defers them to "cierre de G1": GitHub-fake reconstruction, the persistent state store and Tasks projection, `simulate`, heartbeat/timeout, the git/worktree fake, and the e2e cases "gate blocks M1" and "candidate SHA invalidation".
- The author session of #22 recorded this deferral. Under ORCH §7.2 step 5, only _low, non-functional_ debt can be deferred, and both auditors must accept it. These are functional M0 acceptance criteria, and G0 depends on all M0 packages.
- To clear this, either implement them or get an explicit user decision (ADR) that narrows FND-ORCH scope for G0.

## External blocks (explicit; G0 cannot be marked passed while open unless the user rules otherwise)

- **E1. Branch protection / trusted gate evidence.** `main` is unprotected and has no rulesets. Required checks and baseline-manifest protection rely only on convention. SPECS §9.2 (audit identity and results from trusted automation) is unmet. Fixing this needs repository admin action.
- **E2. AWS viability.** Deferred by ADR-0002. There is no RDS/IAM inventory; `infra/plan/AWS.md` states this honestly. It must stay recorded as pending, not passed.

## Non-blocking findings (verified)

- **N1 (Low-Med).** `OrchestratorRuntime.complete` deduplicates `eventId` globally (`runtime.ts:164`). Reusing an eventId for a different task silently no-ops: in my probe, task `b` stayed `leased` and no error was raised. Key it by task, or reject a mismatch.
- **N2 (Low).** An expired lease still blocks `handoff` (`runtime.ts:93`) and keeps holding its paths against other tasks (`runtime.ts:125-132`) until the same task is re-acquired. There is no release/reap API.
- **N3 (Low).** The runtime's `Model` union (`domain.ts:2`) cannot represent historical evidence models (`gpt-5.6-luna`, `claude-sonnet-5`). After `handoff`, codex-era candidates fail `validateCandidate`, which conflicts with ADR-0007's rule to preserve evidence by SHA/model.
- **N4 (Low, documented).** The auth and tenancy slices use two separate session and membership models: `IdentityService` uses a per-identity `authorizationVersion` with an in-memory store, while `TenantContextResolver` uses `TenantSessionEntity` with a membership-projection version. Nothing wires them together, so an identity-side revocation does not reach the tenancy resolver. This is disclosed as pre-G1 work in `docs/tasks/CORE-AUTH-M1-20261004.md:46-47`.
- **N5 (Low).** `TenantControlPlane.provision` (`apps/api/tenants/src/index.ts`) has no authorisation check and no tests. The "last administrator" rule is not enforced (`packages/domain/identity/src/index.ts:147-150`, documented).
- **N6 (Low).** The ESLint config (`eslint.config.mjs`) enables only `no-console` and `no-unused-vars`. It has no type-aware async rules and no module-boundary rule, and production code deep-imports across packages (`apps/api/auth/src/index.ts:1-9`, `apps/worker/base/src/index.ts:1-4`), against SPECS §9.1 "imports por límites de módulo". The code currently passes the stricter async/any rules.
- **N7 (Low).** Outbox `payload` is stored without sanitisation (`packages/platform/outbox/src/index.ts:250`), while SPECS line 265 says the outbox stores no keys or documents. Audit data is strictly allow-listed (good).
- **N8 (Low, doc).** `AGENTS.md:18` still says "sin runtime/CI implementados", which is stale.

## Security and multi-tenancy positives (verified)

- Opaque 256-bit session, invitation and recovery tokens are stored as SHA-256 hashes and compared with `timingSafeEqual`.
- Recovery does not enumerate accounts: the lookup runs in the background and is throttled.
- Invitations are superseded on reissue, and a different subject cannot take over a linked identity.
- `authenticate` checks session expiry, revocation, `authorizationVersion` and active membership.
- The audit persistence shape is built field by field, data is allow-listed to `attempts`, and actor IDs are regex-gated.
- The outbox is scoped by `(tenantId,eventId)`, with fencing on ack/retry, a handler checkpoint before audit, and suspended or missing tenants rejected before the handler runs.
- Tenancy fences provisioning attempts, gives each attempt its own database and credential, applies the membership projection only for newer versions, accepts only resolver-issued contexts, and was shown on real MySQL to deny tenant A access to tenant B's database.
- CI: actions are pinned by SHA, `permissions: contents: read`, MySQL service with integration tests that fail closed, e2e runs with `retries: 0`, and `forbidOnly` is set in CI.

## Required to re-audit

1. Fix B1: coverage thresholds for every production package, plus tests for the lost-ack, exhausted-attempts and heartbeat paths and for `apps/api/tenants`.
2. Fix B2: check all earlier gates and stage completeness in `acquire`/`setGate`, invalidate on late registration, reject empty-stage passes, validate `restore`, and correct the FND-ORCH.md claim.
3. Resolve B3 by implementing the items or recording an explicit user decision.
4. Publish the cumulative inventory (#1–#22 with mergeSHAs) with the new G0 report.
5. Keep E1 and E2 explicit.
