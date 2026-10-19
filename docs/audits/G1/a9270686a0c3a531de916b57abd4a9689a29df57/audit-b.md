# G1 gate audit B (round 2): OPSLOG `main@a9270686a0c3a531de916b57abd4a9689a29df57`

- **Auditor:** independent G1 gate auditor B, model `claude-opus-5-5` (Anthropic, the active provider).
  - I am not the author of any M1 PR (#25–#37).
  - I did not read the other auditor's report for this SHA or for b53f7af. My only input from round 1 is the summary in my brief: "invitation revoke missing; suspended-company accept".
- **Date:** 2026-10-06.
- **Workspace:** detached worktree `/tmp/g1b-r2` at a927068, used read-only.
  - Mutations were applied temporarily and reverted with `git checkout`. `git status --short` was empty at the end, and the worktree was removed.
- **Environment:**
  - Node 22.22.0, pnpm 11.25.0.
  - A throwaway loopback `mysqld` 8.0.46 (Ubuntu package) with a temporary datadir on 127.0.0.1:3307. It was stopped and its data deleted afterwards. Docker was not used.
  - No AWS, no `.env`, synthetic data only.
  - The Playwright browser download is blocked by the sandbox proxy, so e2e evidence comes from CI (see below).

## Verdict: **REQUEST_CHANGES**

1. **The two round-1 blockers are fixed, and I verified both independently.** PR #37 (head `61af137`, merged as a927068) fixes both. I checked the code, re-ran the tests on real MySQL and applied mutations.
   - **Invitation revoke:** deactivating a pending invitee, an administrator included, revokes the invitation. Afterwards the token gives the uniform 404 in memory, on TypeORM with the fake driver, and on real MySQL.
   - **Suspended-company accept:** a redemption in a suspended tenant fails with the uniform error and consumes nothing. Accept, revoke and suspend are now serialized under the tenant lock.
2. **The gates are green locally on this SHA**, `test:integration` included (real MySQL, 0 skipped). CI `quality` on a927068 is green, with e2e.
3. **I found no exploitable cross-tenant path, auth bypass or role escalation.**
4. **Two Medium findings remain, and Medium blocks G1:**
   - **M1:** an explicit M1 acceptance criterion and an isolation-matrix row are neither implemented nor deferred: "roles cambiados no permiten … jobs" and "cambio de permisos con trabajo pendiente".
   - **M2:** the ADR-0008 deadline for Storybook and visual regression ("como máximo a G1") has passed without an owner decision.

   M1 can be closed with a small code change and a test, or with an owner deferral. M2 needs an owner decision or implementation.

## Commands run (this SHA)

| Command | Result |
| --- | --- |
| `git worktree add --detach /tmp/g1b-r2 a927068…` | OK; HEAD = a9270686a0c3a531de916b57abd4a9689a29df57 |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm baseline:check` | PASS: "12 files across 5 manifests". `git diff 8b1b61c a927068 -- docs/baselines SPECS.md Orchestrator.md AGENTS.md CLAUDE.md` is empty. ADR-0008 changed only in its G0-record wording, and ADR-0009 was added |
| `pnpm leak:scan` | PASS: "Secret scan OK: 299 tracked files". Every allowed fixture is listed in the output. My own grep of `git log -p --all` with the same patterns found only the synthetic fixtures |
| `pnpm lint` | PASS (exit 0, `--max-warnings 0`) |
| `pnpm format:check` | PASS |
| `pnpm typecheck` / `pnpm build` (`tsc -b`) | PASS / PASS |
| `pnpm test:unit` | PASS, exit 0. Every per-package threshold was met (table below) |
| `CI=1 OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3307/mysql pnpm test:integration` | PASS, exit 0. Results below the table |
| `pnpm audit --audit-level high` | PASS. 1 low (`@eslint/plugin-kit` ReDoS, dev) and 3 moderate (`mysql2` ≤3.23.0 zlib bomb, needs protocol compression, which is not enabled; `vitest`/`@vitest/mocker`, dev only). All are already recorded in the FIX-G1 table |
| Full Vite production build of `apps/web/app` (all deps bundled, my own config outside the repo, `NODE_ENV=production`) | Built in 5m49s. `grep -c 'createMockApi\|createFakeOidc\|fake-code\|cuenta-admin\|createHttpApi\|mockApi'` = **0**; the fail-closed text is present (1) |
| Coverage gate is real: `vitest run apps/api/bff … --coverage.thresholds.branches=99.9` | exit 1, so thresholds fail the command |
| GitHub check-runs for a927068 | `quality` success, job 112201531231, head_sha a927068. Steps succeeded: leak-scan, install, `pnpm audit`, `pnpm quality` and `pnpm test:e2e`. PR head 61af137 has `quality` and GitGuardian green |
| `GET /repos/aleiruiz/OPSLOG/rulesets/24547352` | `protect-main` is active on the default branch. Rules: deletion, non_fast_forward, required status check `quality` (strict), pull_request with 0 approvals. `bypass_actors` is `[]` |
| `pnpm exec playwright install chromium` | Blocked by the proxy. e2e evidence is the CI run above |

**`test:integration` results (real MySQL 8.0.46, 0 skipped):**

| Suite | Result |
| --- | --- |
| Harness | 1/1 |
| `persistence/tenancy` | 5/5 |
| `persistence/identity` | 30/30 |
| Platform | 15 files, 139/139; composition coverage 99.52 / 97.88 / 98.36 / 99.52 |

`mysql-identity.test.ts` ran 6/6, including the cross-pool races accept-first, revoke-first and "no phantom administrator".

**Coverage measured by `test:unit` (lines / branches / functions):**

| Package | Threshold (L/F/S/B) | Measured |
| --- | --- | --- |
| contracts | 95/95/95/90 | 100 / 98.71 / 100 |
| ui | 90/90/90/85 | 100 / 97.29 / 100 |
| web | 90/90/90/85 | 99.61 / 94.83 / 98.74 |
| domain/tenants | 95/95/95/90 | 100 / 100 / 100 |
| persistence/tenancy | 95/95/95/90 | 99.75 / 97.39 / 100 |
| persistence/identity | 95/95/95/90 | 100 / 98.16 / 98.76 |
| tools/orchestrator | 90/90/90/85 | 100 / 92.73 / 100 |
| domain/identity | 95/95/95/90 | 99.74 / 99.55 / 100 |
| platform/auth | 95/95/95/90 | 100 / 100 / 100 |
| api/auth | 95/95/95/90 | 100 / 100 / 100 |
| api/bff | 95/95/95/90 | 100 / 99 / 100 |
| worker/base | 90/90/90/85 | 100 / 100 / 100 |
| platform/audit | 90/90/90/85 | 94.39 / 94.11 / 100 |
| platform/outbox | 90/90/90/85 | 98.92 / 92.55 / 100 |
| infra/queues | 90/90/90/85 | 100 / 100 / 100 |
| api/tenants | 95/95/95/90 | 100 / 100 / 100 |
| domain/files | 95/95/95/90 | 100 / 100 / 100 |
| platform/files | 95/95/95/90 | 100 / 100 / 100 |
| api/files | 95/95/95/90 | 100 / 98.64 / 100 |
| infra/storage | 90/90/90/85 | 100 / 100 / 100 |
| infra/runtime | 90/90/90/85 | 100 / 97.46 / 100 |
| harness | lines 80 | 100 |
| composition (`test:platform`) | 95/95/95/90 | 99.52 / 97.88 / 98.36 |

## Independent verification of the round-1 fixes (PR #37)

| Item | Code | Tests (my run) | Mutation I applied → result |
| --- | --- | --- | --- |
| Pending invitation is revocable | `apps/api/composition/src/platform.ts:746-760` (pending branch: `identity.revokeMembership`, `access.revokePending`, audit `invitation.revoked`); `packages/persistence/identity/src/store.ts:571-574` (consumes unconsumed invitation rows in the same transaction, under the tenant lock) | `invitations.test.ts`, `bff.test.ts` "invitation lifecycle through HTTP", `persistent-identity.test.ts`, `mysql-identity.test.ts`, identity `mysql.integration.test.ts` | Dropping `identity.revokeMembership` from the pending branch → 4 fail. Dropping the invitation `update` in `store.ts` → 2 fail in the package (fake driver and MySQL) and 2 in the platform suite (TypeORM fake and real MySQL) |
| Suspended tenant cannot accept | `platform.ts:603-605, 617-618` (status check under the tenant lock, before any store write) | Four suites (memory, BFF, TypeORM, race) | Disabling the status check → 4 fail |
| Accept vs revoke vs suspend serialization | `platform.ts:417-427, 482-493, 603-605` | `invitation-race.test.ts` (memory and TypeORM fake); `mysql-identity.test.ts` (cross-pool) | Accept not under the lock → 5 fail. `setStatus` not under the lock → 2 fail |
| Stored-role confirmation (N3 of A) | `access.ts:149-153` | `persistent-identity.test.ts` | Ignoring the store → 2 fail |

The remaining paths fail closed:

- **Revoked invitation:** inspect gives `not_found` (`platform.ts:821-828`). Accept fails in the store, because the membership is no longer `pending` (`packages/domain/identity/src/index.ts:245-254`; `store.ts` re-validates under the row lock). I confirmed both by reading the code.
- **Cross-tenant revoke attempt:** `hasPending(target, callerTenant)` is false, so the answer is `not_found` and B's invitation stays redeemable. This is tested.

## Requirements and traceability

| Area (Orchestrator §8 M1 / SPECS §4, §5.4, §9) | Result | Evidence |
| --- | --- | --- |
| Tenant → user → object → audit, A/B (CORE-INTEGRATE) | PASS | `flow.test.ts`, `isolation.test.ts`, `bff.test.ts` (A/B over HTTP; foreign ids give an identical 404) |
| Credentials A denied on B (CORE-TENANCY) | PASS (real MySQL) | `tests/harness/mysql.integration.test.ts` (cross-tenant connection `rejects /denied/`); tenancy `mysql.integration.test.ts` |
| Provisioning failure does not activate a tenant; retries and leases | PASS | Tenancy MySQL suite 5/5 |
| Revoked sessions / changed roles block **operations** | PASS | `sessions.test.ts`; `TenantGate` plus projection bump; `effectiveRole` against the store |
| Revoked sessions / changed roles block **jobs** | **NOT MET, not deferred** | See **M1** |
| Last administrator, concurrent, cross-process | PASS | `negative.test.ts`; MySQL x10 rounds; `mysql-identity` phantom-admin race |
| Files: fake, pending or foreign never downloaded; revocation blocks the proxy; scanner down only queues | PASS (in-memory storage; AWS deferred) | `api/files` tests; `jobs.test.ts:210`; grants bound to tenant, actor and expiry (`apps/api/files/src/index.ts:236-243`) |
| Audit without PII; rollback does not publish; retry does not duplicate | PASS (in memory) | `flow.test.ts`, `jobs.test.ts` |
| Durable outbox/audit reconciliation (CORE-AUDIT) | Deferred and documented (owner action listed in the FIX-G1 table) | Out of scope per my brief |
| Web: no tokens in browser storage; routes follow permissions; drafts kept on expiry | PASS (CI e2e on the mock; unit tests) | `e2e/web-shell.spec.ts:141,165`; production bundle excludes mock and fake OIDC (my full build: 0 markers) |
| CSRF / Origin / cookies | PASS | `apps/api/bff/src/handler.ts:156-183`; `csrf.ts` (session-bound HMAC, signed double-submit before login, exact Origin plus Host plus Sec-Fetch-Site); cookie `HttpOnly; Secure; SameSite=Lax` |
| SQL / migrations | PASS | No string-built SQL in runtime code. DDL only in migrations and test setup, with identifier allowlists. Runtime account is DML-only (asserted on MySQL) |
| CI required checks and ruleset | PASS | `quality` is required and strict; the PR rule is on; CI includes audit, leak scan, MySQL and e2e; actions pinned by SHA; `persist-credentials: false` |
| Coverage thresholds really enforced | PASS (see L3 for tiering) | All met; a threshold violation exits 1 |
| Baseline / hash manifests | PASS | `baseline:check`; no baseline file changed since G0 |
| Mutation testing on permission rules (SPECS §9.1) | Partial (L2) | My 13 permission mutants: 12 killed, 1 survived |
| Traceability matrix per requirement | Stale in places (L1) | `docs/traceability/FND-CONTRACTS.md` |
| Visual regression / Storybook (SPECS §9.1, ADR-0008) | **Deadline expired** | See **M2** |

**Known deferrals confirmed as documented (not reported as findings):**

- **AWS / S3 / KMS / IAM and real staging:** ADR-0002, `infra/runtime/STAGING.md`. The guards are tested.
- **Real OIDC, MFA/TOTP, password policy, rate limits and email:** CORE-INTEGRATE FIX-G1 table and Slice 3 limits.
- **Durable queue, outbox and audit:** the same table.
- **FND-ORCH and the orchestrator:** ADR-0009, an owner decision transcribed in the ADR and not verifiable from the repository.
- **Cross-process residuals:** the in-memory `AccessDirectory`, invitation registry and per-tenant lock; the `changeRole` compensation is not distributed.

## Findings

### High

None.

### Medium (blocking)

**M1. Jobs never re-check the enqueuing actor's current membership or permission. This explicit M1 acceptance item and isolation-matrix row is not implemented, not tested and not recorded as deferred.**

- **Requirement:**
  - `Orchestrator.md:232` (CORE-AUTH acceptance): "sesiones revocadas y roles cambiados no permiten operaciones/**jobs**".
  - `SPECS.md:156`: "worker verifica contexto, recurso y **permiso actual antes de ejecutar** … Un job no autorizado termina sin datos".
  - `SPECS.md:168` (isolation matrix): "cambio de permisos con trabajo pendiente". `SPECS.md:170` makes negative tests blocking in every cumulative audit.
  - Orchestrator §8 G1 names "caches/jobs" in scope.
- **Code:**
  - `Platform.publish` (`apps/api/composition/src/platform.ts:1075-1103`) enqueues outbox events with `actorRef: { subject: 'user-<id>', kind: 'user' }`.
  - `Worker.process` (`apps/worker/base/src/index.ts:50-…`, the gate at `:78`) checks only `tenants.status(record.tenantId)` before invoking the handler.
  - Nothing consults the actor's membership, authorization version or permission. `apps/worker/composition/src/index.ts` adds tenant-status filtering for scans only.
- **Tests and docs:**
  - `tests/integration/platform/jobs.test.ts` covers suspended or absent tenants, rollback, dedup and retry, but not a revoked or demoted actor with pending work.
  - The CORE-INTEGRATE traceability row "Jobs de tenant suspendido/ausente rechazados" maps only the tenant half.
  - Neither the CORE-AUTH, CORE-AUDIT or CORE-INTEGRATE task files nor the FIX-G1 table list this as deferred. A grep for "trabajo pendiente", "permiso actual" and job/actor checks finds nothing.
- **Reproduction (by reading the code):**
  1. Admin A publishes an event through `platform.publish(tokenA, …, emit → emit({...}))`.
  2. Another admin removes A (`removeMember`), or demotes A with `changeRole`.
  3. `platform.runtime.drainOutbox()` invokes the registered handler with A's event, and the audit records `outbox.delivered`.
  4. The worker has no code path that could refuse this, because it never reads `actorRef`.
- **Impact today:** low, because M1 has no user-scoped handler that returns data. It becomes a real exposure with the first export, import or notification job (M2/M5), and it is a stated M1 acceptance item.
- **Remediation (either option):**
  - **(a) Implement and test.** Add an actor guard to the worker: for `actorRef.kind === 'user'`, resolve the membership in the control plane (active, same tenant) and fail closed without invoking the handler, to DLQ or terminal without data. Add a "permission change with pending work" test in `jobs.test.ts`.
  - **(b) Defer explicitly.** Record an owner-approved deferral to the first package with a user-scoped job, with a traceability row and a blocking test obligation in that package.

**M2. The ADR-0008 design deferral has expired: there is no Storybook runtime and no visual-regression snapshots, yet functional screens exist.**

- **Requirement:**
  - `SPECS.md:307`: "UI: pruebas de interacción, axe y **regresión visual** del design system y pantallas representativas". `SPECS.md:94` names Storybook.
  - `docs/adr/0008-g0-gate-audit-and-m1-exception.md:21` deferred both "a antes de la primera pantalla funcional y, como máximo, a G1".
- **State:**
  - The first functional screens merged in #28 (084644d).
  - `e2e/components.spec.ts-snapshots/` contains only `gallery.aria.yml` (an ARIA snapshot). `grep -rn 'toHaveScreenshot\|toMatchSnapshot' e2e` returns nothing.
  - The repository's own table marks this as "Vencido … el propietario debe ampliar o eximir el plazo" (`docs/tasks/CORE-INTEGRATE-M1-20261006.md:275`). No ADR or owner decision extends or waives it.
- **Why blocking:** G1 is the latest deadline the owner accepted. Passing G1 without implementing it or recording a new owner decision would leave a mandatory control (SPECS §9.1) with neither implementation nor accepted deferral. That is the same situation as G0's E1.
- **Remediation (either option):**
  - Add pixel snapshots for the design-system gallery and representative screens. Playwright `toHaveScreenshot` under the existing e2e is enough, and a Storybook runtime could follow.
  - Or record the owner's extension or waiver in a successor ADR.

### Low

**L1. The traceability matrix is stale for M1 rows. It mostly understates, but it is inaccurate.** `docs/traceability/FND-CONTRACTS.md`:

- **AC-1…AC-5 (lines 11-15):** still "pending: no M0 consumer". SPECS §10.1 maps AC-1–5 to G0/G1, and several are implemented and tested in M1:
  - AC-1, session-tenant only: `isolation.test.ts`.
  - AC-3, short-lived grants: `api/files`.
  - AC-4, deactivation invalidates sessions: `sessions.test.ts`.
  - AC-5 is covered by default D21.
- **FR-014 (line 66):** "pending" without the SPECS §2.3 D6/D7 decision, "una membresía activa por identidad". The code enforces it: an external subject links to exactly one identity, so `activateInvitation` refuses a second link (`packages/domain/identity/src/index.ts:250-252`).
- **NFR-S5 (line 198):** says "HttpOnly/Secure/SameSite cookie and BFF not implemented". Both were delivered in #33 (`apps/api/bff/src/cookies.ts`).
- **FR-002 and FR-012 (lines 60, 64):** say identity is in-memory or has "no persistent adapter". `TypeOrmIdentityStore` and its MySQL suite were delivered in #32.
- **FR-010, FR-011, FR-021:** still say "web screen runs on a mock port". A typed BFF client has existed since #35.

The header claims an update "hasta `3eabccb`", which post-dates #32, #33 and #35. **Fix:** update these rows before the G1 report publishes its per-requirement inventory (ORCH §7.2(2), (5)).

**L2. There is no versioned mutation testing for permission rules (SPECS §9.1), and one surviving mutant has no test.**

- The repository has no mutation harness; authors and auditors mutate by hand.
- Of my 13 permission and isolation mutants, 12 were killed:
  - `requirePermission` no-op;
  - viewer gains `manage_users`;
  - auditor gains `manage_config`;
  - editor gains `view_pii`;
  - grant subject check removed;
  - PII status check removed;
  - `listAudit`, `inviteUser`, `copyRole` and `getSettings` downgraded to `view`;
  - last-admin check removed;
  - PII upload without `view_pii`.
- **Survivor:** removing `resolved.tenantId !== context.tenantId ||` in `TenantGate.assertActive` (`apps/api/composition/src/platform.ts:149`). All 253 tests still pass.
  - It is defense in depth that the normal flow cannot reach, the same shape as N2 (subject comparison), which now has a test.
  - **Fix:** add a test that rewrites the control-plane mirror to another tenant, as `sessions.test.ts:142-160` does for the subject. Before M2 adds assignment and transition rules, add a versioned mutation run or a script.

**L3. Coverage tiering is weaker than SPECS §9.1 for some isolation and authorization logic.**

- `package.json:13` enforces 90/85 on `apps/worker/base` (it rejects jobs of suspended or absent tenants, which is isolation) and on `apps/web` (route guards and permission hiding, which is authorization).
- SPECS requires 95/90 for "autorización/aislamiento". Measured values meet 95/90 today (100/100 and 99.61/94.83), so this is only regression protection.
- **Fix:** raise these thresholds.

**L4. e2e runs only against the in-memory mock, not the BFF.** `e2e/web-shell.spec.ts` covers the SPECS §9.1 critical flows (invitation, login, revocation) through `createMockApi`. The real BFF ↔ client path is covered only in Node (`tests/integration/platform/web-client.test.ts`).

- This follows from the real-OIDC deferral and is listed in the FIX-G1 table.
- I record it because round 1's invitation finding was invisible to the mock-based e2e.
- **Fix:** when an OIDC sandbox exists, add one Playwright flow against the BFF.

### Info

- **I1. Redemptions the composition does not know skip the tenant-status pre-check.** For an invitation unknown to this process's registry (`platform.ts:603-605`, `lockedTenantId === null`, for example after a restart with the persistent store), the redemption skips the status pre-check.
  - The store consumes the invitation. Then `access.activate` fails, and the membership is revoked with `forbidden`.
  - This fails closed, but in that path the invitation is burnt, which contradicts "consumes nothing".
  - It is part of the documented cross-process residual (in-memory `AccessDirectory` and invitation registry). It should be closed when the directory is rehydrated from the store.
- **I2. The leak scan checks the current tree only.** `tests/harness/leak-scan.mjs` scans the tree, not history. GitGuardian runs on PRs as well, and my history grep was clean.
- **I3. Per-PR audit evidence lives outside the repository.** The one Opus audit per PR and headSHA (AGENTS.md rule 7) is recorded only in task documents and PR text; for #37, for example, there is no artifact on GitHub. The orchestrator's G1 inventory (ORCH §7.2(2)) should link each mergeSHA to its audit session.
- **I4. The ruleset is not versioned.** It is verified through the API but not in the repository, and `bypass_actors: []` is shown as seen by this token. This is consistent with the FIX-G1 table (precondition P1 closed).
- **I5. Other open items are already documented.** These carry over from the FIX-G1 table and still apply:
  - operator operations without authorization of their own (`platform.ts:433-493`, not reachable over HTTP);
  - `publish` permission chosen by the caller (`platform.ts:1079`);
  - `mfa` and `sessionIdleHours` recorded but not applied;
  - `/api` vs `/api/v1`;
  - `__Host-` cookie names;
  - `name_key` not enforced in the database.

  None is exploitable through the BFF today.

## Security review notes (no findings beyond the above)

- **Tenant and actor provenance.** Every composition entry point derives tenant and actor from the opaque session. Before route logic, the BFF rejects bodies with unknown keys, `tenantId` included.
- **Authorization checks.**
  - `TenantGate` re-resolves the control-plane session on every `authenticate`, checking tenant active, membership version, subject and verified location.
  - Permissions are re-resolved per call.
  - A role disagreement with the store fails closed.
- **Admin-operation locking.** Admin operations re-authorize inside the tenant lock.
- **Role drift.** I found no role escalation: only `admin` holds `manage_users` or `manage_config` (`access.ts:10-31`). Invitation roles come from a closed set (`isRoleName`).
- **Cursors and errors.** Cursors are HMAC-signed and bound to tenant and query. Error bodies are uniform, and `onError` receives only the class name.
- **Files.** Type is checked by magic bytes and files are quarantined. Grants are HMAC-bound to tenant, file and actor with a TTL of at most 15 minutes. The download proxy re-checks session, permission, PII, status and SHA-256. Responses carry `Content-Disposition` attachment, `nosniff` and a sandbox CSP.
- **Secrets.** The BFF and grant secrets require at least 32 characters. Runtime DB accounts must be named `opslog_identity_*` or `opslog_control_*` and are DML-only. The admin and migration data sources are separate.
- **Production web bundle.** Verified with a full build (above) and by `productionBundle.test.ts` with its positive control.

## Cleanup

- `mysqld` stopped and `/tmp/g1b-mysql` deleted.
- Temporary Vite config deleted.
- `git worktree remove /tmp/g1b-r2` done.
- No repository file was modified.
