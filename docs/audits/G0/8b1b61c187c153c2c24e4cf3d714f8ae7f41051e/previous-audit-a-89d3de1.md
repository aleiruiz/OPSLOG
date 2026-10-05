# G0 gate audit (auditor A): `main@89d3de10cdebe22c001443d7dd0585374f4f9029`

- Auditor: independent G0 gate auditor, model `claude-opus-5-5` (Anthropic). I am not the author of any PR in this scope. Clean context; I did not read the second auditor's report or the prior-round audit reports.
- Date: 2026-10-05
- Workspace: clean checkout `/tmp/claude-0/g0v2-a` at `89d3de1`. I did not edit, commit or push anything, and `git status` was clean after every run. Temporary configs, probes and coverage output stayed outside the repo.
- Environment: Node v22.22.0 (engines `>=22.13.0`), pnpm 11.25.0, ephemeral Docker `mysql:8.0.45` on loopback with synthetic data only (removed afterwards), Chromium 1194 from `/opt/pw-browsers`. No AWS, no `.env`, no real data.
- Scope: everything up to this SHA. That covers M0 foundations (FND-REPO/CONTRACTS/DS/AWS/ORCH/INTEGRATE), the M1 slices merged under the ADR-0008 exception (#15 audit/outbox, #16 tenancy, #17 auth, #20 follow-ups), the orchestrator runtime, and the G0 close-out PRs #21 (`940fbdf`) and #22 (`89d3de1`).

## Verdict: **REQUEST CHANGES**

All the commands pass, and the design-system evidence improved a lot since the previous round. Five verified blockers remain against the §7 gate criteria, SPECS §9.1 and the FND-ORCH/FND-INTEGRATE acceptance criteria (B1–B5 below).

## Commands and results

| #   | Command                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                                                                                                      | OK (exit 0)                                                                                                                                                                                                                                                                                                                                             |
| 2   | `pnpm baseline:check`                                                                                                                 | `Baseline integrity OK: 12 files across 5 manifests`. Independent `sha256sum SPECS.md Orchestrator.md` matches BASELINE-1.0.json                                                                                                                                                                                                                        |
| 3   | `pnpm lint`                                                                                                                           | exit 0, 0 warnings                                                                                                                                                                                                                                                                                                                                      |
| 4   | `pnpm format:check`                                                                                                                   | `All matched files use Prettier code style!`                                                                                                                                                                                                                                                                                                            |
| 5   | `pnpm typecheck` (`tsc -b`) and `pnpm build`                                                                                          | exit 0 / exit 0                                                                                                                                                                                                                                                                                                                                         |
| 6   | `pnpm test:unit`                                                                                                                      | exit 0. contracts 15/15 (cov 100/99.23/100/100); ui 13/13 (100/97.29/100/100); ui axe (jsdom) 2/2; domain-tenants 2/2 (**no coverage measured**); persistence-tenancy unit 14/14 (**no coverage measured**); orchestrator 10/10 (99.05 stmts, 87.75 branches, 100 funcs, threshold 90/85 OK); M1 packages 73/73 (**no coverage measured**); harness 4/4 |
| 7   | `OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3407/mysql pnpm test:integration` (MySQL 8.0.45)                                  | harness 1/1 (two isolated DBs, rollback A, concurrent A/B); persistence-tenancy 5/5. Both suites throw if the URL is missing, so they cannot be skipped                                                                                                                                                                                                 |
| 8   | Playwright e2e, chromium, temp config outside the repo (port 4391, `retries: 0`, `forbidOnly`, `executablePath` set to chromium-1194) | **8/8 passed** (gallery render, stateful interaction, axe WCAG 2.1 A/AA with >20 contrast passes, ARIA snapshot, type scale 22/16/14 px, no overflow at 360/1280, keyboard + 3px focus outline, 17 stories + axe)                                                                                                                                       |
| 9   | `pnpm audit --audit-level high`                                                                                                       | exit 0 (1 low, 3 moderate)                                                                                                                                                                                                                                                                                                                              |
| 10  | Remote CI for the SHA (`gh api .../commits/89d3de1/check-runs`)                                                                       | `quality` completed **success** (run 37383508004)                                                                                                                                                                                                                                                                                                       |
| 11  | `gh api repos/aleiruiz/OPSLOG/branches/main/protection` and `/rulesets` (read-only)                                                   | `404 Branch not protected`, rulesets `[]`                                                                                                                                                                                                                                                                                                               |
| 12  | Coverage I measured myself with vitest v8, outside the scripts (details in B1)                                                        | several production packages below the §9.1 thresholds                                                                                                                                                                                                                                                                                                   |
| 13  | Orchestrator probe against the compiled `tests/orchestrator/dist` runtime (details in B2)                                             | gate invalidation does not block later stages; a gate passes without two-auditor evidence                                                                                                                                                                                                                                                               |

## Per-criterion evaluation (ORCH §7 / §8 G0, SPECS §8–§9)

| Criterion                                                                            | Result                           | Evidence                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline integrity and immutability                                                  | PASS                             | Commands 2 and 11. Originals only changed in `87a2d62`. Weakness: there is no branch protection or CODEOWNERS, so an author PR could edit a manifest and its file together (see B4)                                                                                 |
| Reproducible workspace, lint, format, typecheck, build                               | PASS                             | Commands 1, 3, 4, 5 and remote `quality` green                                                                                                                                                                                                                      |
| SPECS §9.1 coverage (90/90/90/85; 95/90 for domain, authz and isolation), no retries | **FAIL**                         | Gate exists only for contracts, ui, orchestrator and the harness. No retries: `e2e/playwright.config.mjs` has `retries: 0`; no `.only`/`.skip` found. See B1                                                                                                        |
| MySQL real integration, A/B isolation, concurrency                                   | PASS for the current scope       | Command 7. CI service `mysql:8.0.45` in `.github/workflows/quality.yml`                                                                                                                                                                                             |
| Contracts (valid/invalid cases, no ORM)                                              | PASS                             | contracts tests 15/15 incl. `branches.test.ts`, 100% lines                                                                                                                                                                                                          |
| DS: tokens match SPECS §8                                                            | PASS                             | `packages/ui/src/tokens.ts` matches every SPECS colour, 14/22/16 type scale, 4–48 spacing, radii 6/8, sidebar 232, rows 38/30                                                                                                                                       |
| DS: type scale                                                                       | PASS                             | e2e: h1 22px, h2 16px, body/p 14px                                                                                                                                                                                                                                  |
| DS: text contrast                                                                    | PASS                             | axe in a real browser: 0 violations. My own ratios: all status fg/soft pairs ≥4.73:1, textMuted/background 5.37:1                                                                                                                                                   |
| DS: non-text contrast (WCAG 1.4.11 AA)                                               | **FAIL**                         | See B5                                                                                                                                                                                                                                                              |
| DS: keyboard and focus                                                               | PASS                             | e2e keyboard test (type, Space, ArrowRight/Enter on tabs, Enter on button; 3px solid outline)                                                                                                                                                                       |
| DS: 360px                                                                            | PASS                             | e2e 360/1280 no overflow. I also reviewed a full-page 360px screenshot: no clipping                                                                                                                                                                                 |
| DS: stories and states                                                               | PASS with deferral               | 17 stories rendered and axe-scanned. `UiState` covers all ten SPECS §8 states. Storybook runtime and pixel snapshots deferred (N3)                                                                                                                                  |
| Orchestrator (FND-ORCH acceptance, §7.2/§7.3 gate semantics)                         | **FAIL**                         | See B2 and B3                                                                                                                                                                                                                                                       |
| Traceability honesty                                                                 | PASS with findings               | Matrix does not overclaim M0 functionality, but it is stale and incomplete for merged M1 code (N1)                                                                                                                                                                  |
| ADR-0008 exception handling                                                          | PASS                             | ADR records the out-of-order M1 merges, keeps M1 code in the G0 scope, does not declare G0 passed and forbids new M1 dispatch. `git diff 776abce..89d3de1` shows no M1 source changes after #20. The user ratification itself cannot be verified from the repo (N4) |
| AWS deferral                                                                         | PASS (explicit)                  | ADR-0002, `infra/plan/AWS.md` §2, `docs/tasks/FND-AWS.md` acceptance. Nothing is presented as verified                                                                                                                                                              |
| Branch protection / merge / check governance (FND-INTEGRATE)                         | **FAIL (hidden external block)** | See B4                                                                                                                                                                                                                                                              |
| Current G0 report under §7.2(5)                                                      | Pending                          | `docs/audits/G0/2026-10-04-report.md` is correctly marked HISTÓRICO. The current report is still "pendiente"                                                                                                                                                        |

## Blocking findings

**B1. M1 and tenancy production packages have no coverage gate, and several measure below the SPECS §9.1 thresholds.**

- Where: `package.json:13`. In `test:unit`, `vitest run packages/domain/identity packages/platform/auth apps/api/auth apps/worker/base packages/platform/audit packages/platform/outbox infra/queues` has no `--coverage`. The `@opslog/domain-tenants test` and `@opslog/persistence-tenancy test:unit` steps also have none, and `test:integration` measures nothing.
- ADR-0008 puts this merged code inside the G0 candidate. The #22 coverage gate deliberately covers only ui, contracts and orchestrator, and no deferral of the §9.1 bar for these packages is recorded.
- Measured (vitest v8, `--coverage.include=<pkg>/src/**/*.ts`, tests excluded):

| Package                                                                                    | Stmts     | Branches                     | Funcs     | Lines     |
| ------------------------------------------------------------------------------------------ | --------- | ---------------------------- | --------- | --------- |
| `packages/domain/identity` (authorization domain, needs 95/90)                             | 98.96     | **83.43**                    |           |           |
| `packages/platform/audit`                                                                  |           | **79.54**                    |           |           |
| `apps/api/auth`                                                                            | 88.57     |                              | **85.71** | **88.57** |
| `packages/platform/auth`                                                                   |           |                              | **75**    | **88**    |
| `apps/worker/base`                                                                         |           |                              | **83.33** |           |
| `infra/queues`                                                                             |           |                              | **83.33** |           |
| `packages/persistence/tenancy`, unit + MySQL integration combined (isolation, needs 95/90) |           | **79.72** (`index.ts` 78.67) |           | 93.22     |
| `packages/domain/tenants` (domain), own tests                                              | **48.33** |                              |           |           |

`packages/domain/tenants` reaches 96.8% lines / 87.5% branches only indirectly through `dist`.

- Fix: add per-package thresholds for these packages, including integration, and raise their tests, or record an explicit user-approved deferral.

**B2. The orchestrator gate logic contradicts ORCH §7.2(8) and §7.3. I verified this with a probe against the compiled runtime.**

- Where: `tools/orchestrator/runtime.ts:63-65` (`acquire` checks only `gates.get(stage-1)`) and `:138-157` (`setGate`).
- (a) Invalidation does not block later stages. G0 passed, G1 passed, then `setGate(0,'failed')`, then `acquire` of a stage-2 task succeeds (fencing 3). §7.3 requires `canStart(Mn)` to also hold "no invalidated previous gate".
- (b) A gate passes with only per-PR single-audit candidate evidence (`auditCount: 1`). Nothing models `twoIndependentAuditsPass(candidate)` or a gate candidate SHA.
- (c) A stage with no registered tasks passes vacuously (`setGate(0,'passed')` on an empty runtime).
- None of these is listed among the FND-ORCH deferrals.

**B3. FND-ORCH acceptance criteria are unmet and were deferred by the author, not by an ADR or a user decision.**

- Where: `docs/tasks/FND-ORCH.md:99-110` defers to G1 the rebuild from a GitHub fake, the persistent state store and Tasks projection, the three-agent `simulate` dispatch, git/worktree fake integration, and the e2e cases (M0 bootstrap, recovery, gate blocks M1, SHA invalidation).
- These are acceptance criteria of an M0 package. Orchestrator.md §8 lists "simulación de tres agentes, caída/reinicio … reconstrucción desde GitHub", and G0 depends on all M0 packages.
- The deferral is explicit, which is good, but no ADR or recorded user decision authorizes passing G0 without them. ADR-0002's "external requirements may stay pending" covers AWS only.
- Fix: implement the criteria, or record a user or ADR decision that accepts the partial FND-ORCH for G0.

**B4. Branch protection is missing, and that external block is not recorded anywhere.**

- `gh api .../branches/main/protection` returns 404 and rulesets are `[]`. A repo-wide grep finds no document saying so.
- FND-INTEGRATE acceptance requires validating real merge/check availability and "protección de baseline/gates contra cambios del autor; si permisos externos faltan, no falsear G0". SPECS §9.2 also requires the result to come from trusted automation.
- Today the author's own sessions merged #15–#22 (ADR-0008 acknowledges this for M1), and nothing technically prevents an author PR from editing `docs/baselines/BASELINE-*.json` together with the baseline file.
- Fix: enable required `quality` checks and protection, or record the external block explicitly with an unblock condition.

**B5. Form-field boundaries fail WCAG 1.4.11 non-text contrast (AA).**

- The computed `MuiOutlinedInput-notchedOutline` border is `rgba(0, 0, 0, 0.23)`, about #C4C4C4 on #FFFFFF, roughly **1.7:1** (3:1 required). This is the Filtrar, Nombre and Motivo fields.
- The theme (`packages/ui/src/theme.ts`, `MuiTextField` only sets defaultProps) does not override the MUI default. The `borderStrong` token `#C9CFD8` (1.57:1) would not fix it either.
- axe does not check 1.4.11, so this passes CI. SPECS §8 requires WCAG AA with measured contrast before any screen.
- Fix: a token of at least 3:1, e.g. textMuted `#5C6571` (5.9:1), plus a test.

## Non-blocking findings

- **N1 Traceability.**
  - `docs/traceability/FND-CONTRACTS.md` traces only M0. Merged M1 code (auth/identity, tenancy, audit/outbox) has no requirement→implementation→test→evidence rows.
  - `NFR-S2` (`:193`, tenant isolation) still says "pending: no M0 consumer" although tenancy code and MySQL A/B tests exist.
  - 223 rows say "not CI-verified" even where `index.test.ts` runs in CI.
  - None of this overclaims, but the cumulative inventory under §7.2(2) is incomplete. Put it in the current G0 report.
- **N2 Stale doc.** `docs/tasks/CORE-AUTH-M1-20261004.md:55` says `pnpm quality` is stopped by `format:check`, which now passes. M1 slices honestly record their own CORE-INTEGRATE gaps (OIDC, persistent identity adapter, last-admin concurrency, HTTP/CSRF). Under §7.2(3) these are not G0 requirements.
- **N3 Author-recorded deferral.** `docs/design/FND-DS.md:33` defers the Storybook runtime and pixel visual-regression snapshots. SPECS §9.1 asks for visual regression of the DS. The ARIA snapshot and story rendering are reasonable interim evidence; the user should accept the deferral explicitly.
- **N4 ADR-0008.** The user's ratification and two-auditor authorization are stated in the ADR, which an author session wrote. They cannot be verified from the repo; the gate record should cite the user message.
- **N5 Minor.** MUI Tabs render uppercase (`RESUMEN`), which is inconsistent with `textTransform: 'none'` on buttons. `UiState.tsx:84-85` branch is uncovered. `pnpm audit` reports 3 moderate advisories (below the gate). Remote CI pins Node 22.13.0, local run used 22.22.0, both within engines.

## Verified closures from #21/#22

- Orchestrator in CI with a 90/85 coverage gate.
- Baseline integrity script wired into `quality` (verified).
- Type scale tokens and theme (e2e computed sizes).
- Real-browser axe with measured contrast.
- Keyboard and focus-visible e2e.
- 360px overflow e2e.
- 17 stories rendered and axe-scanned.
- `retries: 0`.
- Historical report marked as such.
- ADR-0008 recorded.
