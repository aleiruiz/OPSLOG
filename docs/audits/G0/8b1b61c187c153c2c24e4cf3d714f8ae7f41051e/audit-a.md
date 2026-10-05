# G0 gate audit (auditor A): `main@8b1b61c187c153c2c24e4cf3d714f8ae7f41051e`

- Auditor: independent G0 gate auditor, model `claude-opus-5-5` (Anthropic). I am not the author of any PR in this scope. Clean context. I did not read the second auditor's report for this SHA. I read only the earlier rounds' reports (89d3de1, 940fbdf) to check closures.
- Date: 2026-10-05
- Workspace: clean checkout `/tmp/claude-0/g0v3-a` at `8b1b61c`. I did not edit, commit or push anything, and `git status --short` was empty at the end. The Playwright config, orchestrator probes and coverage output all stayed in a scratch directory outside the repo.
- Environment:
  - Node v22.22.0 (engines `>=22.13.0`), pnpm 11.25.0.
  - My own ephemeral Docker `mysql:8.0.45` on `127.0.0.1:3418`, synthetic data only, removed afterwards.
  - Chromium 1194 from `/opt/pw-browsers`.
  - No AWS, no `.env`, no real data.
- Scope: everything up to this SHA (cumulative).
  - M0 foundations: FND-REPO/CONTRACTS/DS/AWS/ORCH/INTEGRATE.
  - M1 slices merged under the ADR-0008 exception: #15 audit/outbox, #16 tenancy, #17 auth, #20 follow-ups.
  - Orchestrator runtime.
  - G0 close-out PRs #21, #22 and #23 (`8b1b61c`).

## Verdict: **APPROVE**

All five blockers from the 89d3de1 round are either closed (verified independently) or turned into explicit, recorded decisions or external blocks.

- Every quality command passes locally and remote `quality` is green on this SHA.
- The §9.1 coverage bar is now enforced for every production package, and I confirmed that a threshold breach fails the run (exit 1).
- The orchestrator now blocks later stages after an invalidation and needs two independent approving gate auditors on one SHA.
- The input-border contrast is fixed and tested.

The remaining findings are non-blocking. They are listed below with file:line, and several should be tracked into the G1 deferral list.

This approval is one of the two G0 audits that ORCH §7.2(8) requires. G0 is passed only if the second independent auditor also approves this SHA and the owner records acceptance (§7.2(9)).

## Commands and results

| #   | Command                                                                                                        | Result                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                                                                               | OK                                                                                                                                                    |
| 2   | `pnpm baseline:check`                                                                                          | `Baseline integrity OK: 12 files across 5 manifests`                                                                                                  |
| 3   | `pnpm lint`                                                                                                    | exit 0 (`--max-warnings 0`)                                                                                                                           |
| 4   | `pnpm format:check`                                                                                            | exit 0, "All matched files use Prettier code style!"                                                                                                  |
| 5   | `pnpm exec tsc -b`, then `pnpm build`                                                                          | exit 0 / exit 0                                                                                                                                       |
| 6   | `pnpm test:unit`                                                                                               | exit 0. Per-package coverage is in the next table                                                                                                     |
| 7   | Threshold enforcement probe: `vitest run packages/platform/audit --coverage... --coverage.thresholds.lines=95` | `ERROR: Coverage for lines (94.39%) does not meet global threshold (95%)`, **exit 1**. The thresholds really gate the run                             |
| 8   | `OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3418/mysql pnpm test:integration` (MySQL 8.0.45)           | harness 1/1; persistence-tenancy 5/5 (leases, migrations, rollback/retry across store instances, concurrent provisioning, idempotent retries). exit 0 |
| 9   | Playwright e2e, chromium, temporary config outside the repo                                                    | **9/9 passed**. Details in the note after this table                                                                                                  |
| 10  | `pnpm audit --audit-level high`                                                                                | exit 0 (1 low, 3 moderate)                                                                                                                            |
| 11  | `gh api .../commits/8b1b61c.../check-runs`                                                                     | `quality` completed **success** (id 112025239373). The workflow runs `pnpm quality` + `pnpm test:e2e` with a MySQL 8.0.45 service and pinned actions  |
| 12  | `gh api .../branches/main/protection` and `/rulesets` (read-only)                                              | `404 Branch not protected`, `[]`                                                                                                                      |
| 13  | Orchestrator probes (13 cases, vitest in scratch dir, importing `tools/orchestrator/runtime.ts`)               | Details in the orchestrator section                                                                                                                   |
| 14  | `grep` for `.only(` / `.skip(` / test retries in apps, packages, tests, e2e, tools and infra                   | none. `e2e/playwright.config.mjs` has `retries: 0`                                                                                                    |

Playwright details for row 9:

- Config: `retries: 0`, `forbidOnly: true`, port 4392, `executablePath: /opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- Tests that passed: gallery render, stateful interaction, axe WCAG 2.1 A/AA with measured contrast, ARIA snapshot, type scale, **new: text-field border = `rgb(107, 114, 128)`**, no overflow at 360/1280, keyboard + visible focus, every story + axe.

### Coverage measured by `pnpm test:unit` (all gated at 90/90/90/85)

| Package                      | Tests       | Stmts | Branch | Funcs | Lines | SPECS tier           |
| ---------------------------- | ----------- | ----- | ------ | ----- | ----- | -------------------- |
| packages/contracts           | 15          | 100   | 99.23  | 100   | 100   | 90/85                |
| packages/ui (jsdom)          | 14 (+2 axe) | 100   | 97.29  | 100   | 100   | 90/85                |
| packages/domain/tenants      | 18          | 100   | 100    | 100   | 100   | domain 95/90: met    |
| packages/persistence/tenancy | 181         | 96.2  | 95.84  | 91.02 | 96.2  | isolation 95/90: met |
| tools/orchestrator           | 17          | 100   | 92.73  | 100   | 100   | workflow 95/90: met  |
| packages/domain/identity     | 51          | 99.74 | 99.55  | 100   | 99.74 | authz 95/90: met     |
| packages/platform/auth       | 7           | 100   | 100    | 100   | 100   | authz 95/90: met     |
| apps/api/auth                | 11          | 100   | 96.42  | 100   | 100   | met                  |
| apps/worker/base             | 22          | 100   | 100    | 100   | 100   | met                  |
| packages/platform/audit      | 17          | 94.39 | 94.11  | 100   | 94.39 | 90/85: met           |
| packages/platform/outbox     | 21          | 98.92 | 92.55  | 100   | 98.92 | met                  |
| infra/queues                 | 4           | 100   | 100    | 100   | 100   | met                  |
| apps/api/tenants             | 7           | 100   | 100    | 100   | 100   | met                  |
| tests/harness (tenant-key)   | 4           | 100   | 100    | 100   | 100   | n/a                  |

These are all 12 directories that contain production `src/**/*.ts`, plus the orchestrator.

- `domain-tenants` and `persistence-tenancy` are gated through their package scripts (`packages/domain/tenants/package.json`, `packages/persistence/tenancy/package.json`).
- The rest are gated in `package.json:13`.
- `domain-tenants` is now measured on its own `src` (100%, previously 48% own).

## Per-criterion evaluation (ORCH §7 / §8 G0, SPECS §8–§9, ADR-0008)

| Criterion                                                       | Result                                | Evidence                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline integrity and immutability                             | PASS                                  | Command 2; ACTIVE = SPEC/ORCH-1.4; 1.4 SPECS does not alter §9.1. Protection against author edits depends on branch protection, which is an external block (see the "External blocks" section) |
| Reproducible workspace: install, lint, format, typecheck, build | PASS                                  | Commands 1, 3, 4, 5; remote `quality` green (11)                                                                                                                                               |
| SPECS §9.1 coverage on every production package, enforced       | PASS                                  | Coverage table; enforcement proven by command 7 (exit 1). Prior B1 closed. The 95/90 tier is met by measurement but not encoded (N2)                                                           |
| No retries, no `.only`/skips                                    | PASS                                  | Command 14; `retries: 0`                                                                                                                                                                       |
| MySQL real integration, A/B isolation, concurrency              | PASS (current scope)                  | Command 8; CI MySQL service                                                                                                                                                                    |
| Contracts (valid/invalid, no ORM)                               | PASS                                  | contracts 15/15, 100% lines                                                                                                                                                                    |
| DS tokens / type scale / text contrast                          | PASS                                  | e2e type scale + axe 0 violations in real Chromium                                                                                                                                             |
| DS non-text contrast (WCAG 1.4.11)                              | PASS                                  | Prior B5 closed. Details after the table                                                                                                                                                       |
| DS keyboard, focus, 360px                                       | PASS                                  | e2e 9/9                                                                                                                                                                                        |
| DS stories, states, snapshots                                   | PASS with recorded deferral           | Details after the table                                                                                                                                                                        |
| Orchestrator gate semantics (§7.2(8), §7.3)                     | PASS with non-blocking residuals      | Prior B2 closed. Details after the table                                                                                                                                                       |
| FND-ORCH acceptance                                             | PASS via **attested user deferral**   | Details after the table                                                                                                                                                                        |
| FND-AWS / viability                                             | PASS (explicit deferral)              | ADR-0002, ADR-0008 "Bloqueos externos (b)". Nothing is presented as verified                                                                                                                   |
| FND-INTEGRATE governance / branch protection                    | **External block, honestly recorded** | Details after the table                                                                                                                                                                        |
| ADR-0008 M1 exception handling                                  | PASS                                  | `git diff 776abce..8b1b61c` under M1 `src` shows only tests added (no production-logic changes except UI theme/tokens and orchestrator). New M1 dispatch remains forbidden                     |
| Traceability honesty                                            | PASS (no overclaim), with gaps        | N1                                                                                                                                                                                             |
| Current G0 report under §7.2(5)                                 | Pending, as expected                  | Produced after the two audits. `docs/audits/G0/2026-10-04-report.md` remains historical                                                                                                        |

Details for the longer rows:

- **DS non-text contrast (WCAG 1.4.11).** This closes prior B5.
  - New token `inputBorder` `#6B7280` (`packages/ui/src/tokens.ts:6`), applied in `MuiOutlinedInput.styleOverrides.notchedOutline` (`packages/ui/src/theme.ts`).
  - The unit test asserts a contrast of at least 3:1 against surface and background (`packages/ui/src/tokens.test.ts`).
  - The e2e test asserts the computed border colour.
  - The deviation from the reference border palette is documented in `docs/design/FND-DS.md`.
  - The LinearProgress bar against its track is about 3.4:1 (my estimate).
- **DS stories, states and snapshots.**
  - All stories are rendered and axe-scanned in Chromium, and the ARIA snapshot is stable.
  - Pixel snapshots and the Storybook runtime are deferred to before the first functional screen, and at the latest G1 (ADR-0008 "Diferimientos de diseño", `docs/design/FND-DS.md:33`).
- **Orchestrator gate semantics (§7.2(8), §7.3).** This closes prior B2. Probes:
  - P7: G0 failed after G1 passed blocks stage 2 (`stage 2 is blocked by gate 0`), and G1/G2 reset to pending.
  - `setGate(passed)` requires two distinct approving non-author auditors on one candidate SHA covering every stage task SHA (`runtime.ts:190-210`).
  - An empty stage throws (`:160`).
  - Residual issues are N3–N7.
- **FND-ORCH acceptance.**
  - ADR-0008 records that the user accepted the deferral to G1 on 2026-10-05. The list is in `docs/tasks/FND-ORCH.md:99-111`.
  - **I cannot verify this from the repo.** The caller reports that it came from an in-app decision card. I treat it as an attested owner decision. If the attestation is false, this criterion fails (prior B3).
- **FND-INTEGRATE governance / branch protection.**
  - `main` has no branch protection and no rulesets (command 12). ADR-0008 records this accurately as an owner/admin-only block.
  - The judgement on whether it blocks G0 is in the "External blocks" section.

## Blocking findings

None.

## External blocks: are they recorded honestly, and do they block G0?

- **Branch protection / rulesets missing.**
  - It is recorded truthfully in `docs/adr/0008-g0-gate-audit-and-m1-exception.md:20` ("main no tiene branch protection ni rulesets … Ninguno lo resuelve ni lo declara resuelto este repositorio"). I verified the claim (command 12).
  - FND-INTEGRATE anticipates missing external permissions and requires "si permisos externos faltan, no falsear G0". The repo does not falsify this, so it is **acceptable as a documented external block and not a code blocker for G0**.
  - It does mean the FND-INTEGRATE criterion "protección de baseline/gates contra cambios del autor" is **not met**. Today `baseline:check` cannot stop an author PR that edits a manifest and its file together, and every merge #15–#23 was done by the author session.
  - Recommendation: before G0 is recorded as passed, the owner should either enable protection (required `quality` check, no direct pushes) or record in the G0 report, in one line, that G0 passes with this block open.
  - I did not find a recorded owner acknowledgement that G0 may pass with it open. The ADR only says that the owner is the one who has to resolve it.
- **AWS.** Deferred by ADR-0002, `infra/plan/AWS.md`, and ADR-0008 "(b)". Nothing claims verification. **Acceptable**: ADR-0002/ADR-0005 explicitly allow external requirements to stay pending for G0.

## Non-blocking findings

**N1. Traceability for merged M1 code is still missing.**

- `docs/traceability/FND-CONTRACTS.md` was last changed in #22.
- `docs/tasks/CORE-{AUTH,AUDIT,TENANCY}-M1-20261004.md` contain no FR/NFR/BR identifiers (`grep` count 0).
- `NFR-S2` (`docs/traceability/FND-CONTRACTS.md:193`) still says "pending: no M0 consumer". That is literally true, but it ignores the tenancy code and MySQL A/B tests.
- Nothing is overclaimed. The cumulative inventory under §7.2(2) should go into the G0 report, and the M1 rows are needed by G1 at the latest.

**N2. Coverage gate encodes only the 90/85 tier.**

- `package.json:13` and the two package scripts use 90/90/90/85 everywhere. SPECS §9.1 requires 95 lines / 90 branches for domain, authorization, isolation and workflows, plus "sin caída en código modificado".
- Measured values meet 95/90 today for identity, platform/auth, domain-tenants, persistence-tenancy and the orchestrator. A regression to 91% would still pass CI, though.
- `packages/persistence/tenancy/src/entities.ts` is at 69% lines / 0% funcs. That is TypeORM decorator wiring, which the "wiring declarativo con evidencia de integración" exception covers, and the MySQL suite (command 8) provides that evidence. The aggregate hides it, however.
- Suggested fix: raise the thresholds for these packages to 95/90.

**N3. Orchestrator: an unregistered earlier gate is treated as passed (fail-open).**

- Where:
  - `tools/orchestrator/runtime.ts:71-73` (acquire)
  - `:110-112` (renew)
  - `:131-133` (complete)
  - `:163-165` (setGate)
- Each of these skips a stage when `!this.gates.has(stage)`.
- Probe P1: a runtime with only a stage-1 task registered grants a lease (fencing 1) although G0 never existed and was never passed. §7.3 says `canStart(Mn) = G(n-1).passed`.
- Mitigation: P2 shows that once stage-0 tasks are registered, completion is blocked. The full DAG always contains G0 tasks, and the runtime does not dispatch yet.
- Fix with the G1 deferrals: treat a stage below the highest registered stage with no gate record as blocking, or require a declared stage list.

**N4. Orchestrator: no validation of `task.stage`.**

- `register` (`runtime.ts:29-44`) accepts `NaN`, negatives or fractions.
- Probe P3: a task with `stage: NaN` is leased while G0 is pending, because the loop `stage < NaN` never runs.
- Fix: require a non-negative integer.

**N5. Orchestrator: gate audits are not cumulative and their candidate SHA is unbound.**

- `requireGateAudits` (`runtime.ts:196-205`) checks only that the current stage's task SHAs are in `coveredShas`, and that `candidateSha` is non-empty.
- Probe P6: G1 passes with audits that do not cover the M0 SHAs.
- Probe P5: an arbitrary `candidateSha` (`'zzz'`) and a shared `evidenceId` are both accepted.
- ORCH §7.2(2)/(3) requires cumulative audits. This is consistent with the documented limitation that evidence comes from the caller (`docs/tasks/FND-ORCH.md:111`), but it should be added to that list.

**N6. Orchestrator: idempotency key is global, not per task.**

- `complete` returns silently when `eventId` was already seen (`runtime.ts:123`), even for a different task.
- Probe P11: task `b` stays `leased` with no error after reusing task `a`'s eventId.
- Suggested fix: key it by (taskId, eventId), or throw on a cross-task collision.

**N7. Documented runtime limitations confirmed by probes.**

- P13: an expired lease holder can audit the gate.
- P4: an auditor id that differs from the author only by case or whitespace counts as independent.
- P8: `restore` accepts a forged `passed` gate with any author/SHA.
- P10: `restore` accepts lease paths outside the task scope (`/etc/**`). This one is **not** in the documented list.
- The others are disclosed in `docs/tasks/FND-ORCH.md:111` and accepted for G0 with review in G1.

**N8. Stale documents.**

- `docs/tasks/FND-ORCH.md:97` says "solo Codex está activo en esta ronda… Claude queda inactivo". #21–#23 were authored and reviewed by Claude under ADR-0007.
- `docs/tasks/CORE-AUTH-M1-20261004.md:55` says `format:check` fails, but it passes now.

**N9. Deferrals depend on attestation.**

- The FND-ORCH deferral and the design deferral (Storybook runtime, pixel snapshots) are recorded only in ADR-0008, which an author session wrote. The design bullet does not itself state user acceptance; it inherits the ADR header "adoptado por instrucción directa del usuario".
- The G0 report should cite the owner's decision-card record.

**N10. Minor.**

- MUI Tabs still render uppercase. `theme.ts` sets `textTransform: 'none'` only on `MuiButton` (`packages/ui/src/theme.ts:37-42`).
- `pnpm audit` reports 3 moderate advisories, below the gate.

## Closures verified from prior rounds (89d3de1 B1–B5)

| Prior finding                                 | Status                                                               |
| --------------------------------------------- | -------------------------------------------------------------------- |
| B1 coverage                                   | Closed. Verified on every package, with enforcement proven by exit 1 |
| B2 gate invalidation and two-auditor evidence | Closed (P7, plus the `requireGateAudits` probes)                     |
| B2 empty-stage pass                           | Closed for `setGate`. Residual fail-open in `acquire` (N3)           |
| B3 FND-ORCH                                   | Converted to an attested user deferral                               |
| B4 branch protection                          | Converted to a recorded external block                               |
| B5 input border                               | Closed (token, theme, unit test and e2e)                             |
