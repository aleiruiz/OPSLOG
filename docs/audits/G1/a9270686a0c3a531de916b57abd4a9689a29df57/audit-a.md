# G1 gate audit, round 2 (auditor A): `main@a9270686a0c3a531de916b57abd4a9689a29df57`

- **Auditor:** independent G1 gate auditor A, model `claude-opus-5-5` (Anthropic).
  - I did not author any PR in this scope, and I started with a clean context.
  - I did not read any other auditor's report for G1 (round 1 or round 2). From earlier gates I read only `docs/audits/G0/.../audit-a.md`, and only for its format.
- **Date:** 2026-10-06.
- **Workspace:** detached worktree `/tmp/g1a-r2` at `a927068`.
  - I committed and pushed nothing. Every mutation was reverted with `git checkout` straight after its run, and `git status --short` was empty before I removed the worktree.
  - Probe tests went in a throwaway `.probe/` directory (deleted). The Playwright config override was a temporary file (deleted).
  - The main checkout was only touched by `git fetch origin`, which was needed to obtain the SHA.
  - The worktree and the MySQL data directory have both been removed.
- **Environment:**
  - Node v22.22.0 and pnpm 11.25.0.
  - Throwaway loopback `mysqld` 8.0.46 (Ubuntu package) on `127.0.0.1:3427`, `--initialize-insecure`, temporary datadir. Synthetic data only; the server was shut down and the directory deleted.
  - Chromium 1194 from `/opt/pw-browsers`.
  - No Docker, no AWS, no `.env`, no real data.
- **Scope:** cumulative M0 to M1 up to this SHA. That covers the following, plus FIX-G1 (#37, `a927068`), which closes the round-1 findings on `b53f7af`:
  - G0-approved foundations;
  - M1 #15/#16/#17/#20 under the ADR-0008 exception;
  - CORE-FILES and CORE-WEB;
  - CORE-INTEGRATE slices 1–5 and the coverage tier (#33–#36).

## Verdict: **APPROVE**

I found no High or Medium findings.

**Round-1 fixes.** Both round-1 blockers are fixed. I verified them independently with code reading, my own probes and mutation tests:

- Revoking a pending invitation (B1) works.
- A suspended tenant can no longer accept an invitation (B2).
- The tenant lock now serializes accept, revoke, suspend and reactivate.

**Gates.** Every gate passes locally:

- the static gates and `test:unit`;
- `test:integration` against real MySQL;
- Playwright: 26/26 with Chromium.

Remote `quality` is green on this SHA, including `pnpm test:e2e`.

**Repeated runs.** 20 repeated runs of the race, invitation, negative, BFF and real-MySQL platform suites had no failures; 10 of those 20 used shuffled order. 10 repeated runs of the store's MySQL suite also had no failures.

**Mutation tests.** 25 mutations on security-critical code:

- 22 were killed.
- 3 survived. Each survivor is a defense-in-depth check that a deeper layer masks. They are listed under Low as test gaps.

**Remaining findings.** Four Low and five Info findings. They are not blocking.

**What this approval is.** It is one of the two G1 audits that ORCH §7.2(8) requires. It does not mark G1 as passed. Under ORCH §7.2(8)–(9), G1 needs all of the following:

- the second auditor's approval on this same SHA;
- the report in `docs/audits/G1/<candidateSHA>/`;
- the owner's recorded acceptance.

The owner also has open decisions that this repository cannot settle; see "Gate preconditions" below. The most important is the expired Storybook deferral from ADR-0008.

## Commands and results

| #   | Command                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                                                                                                                                                                                                                         | OK                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | `pnpm baseline:check`                                                                                                                                                                                                                                    | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | `pnpm leak:scan`                                                                                                                                                                                                                                         | exit 0. "Secret scan OK: 299 tracked files". It lists 4 allowed fixtures: `apps/api/files/src/index.test.ts:286`, `infra/runtime/src/index.test.ts:92-93` and `packages/platform/audit/src/index.test.ts:295`                                                                                                                                                                                                                      |
| 4   | `pnpm lint`                                                                                                                                                                                                                                              | exit 0 (`--max-warnings 0`)                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | `pnpm format:check`                                                                                                                                                                                                                                      | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `pnpm typecheck`, then `pnpm build`                                                                                                                                                                                                                      | exit 0 / exit 0                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | `pnpm test:unit`                                                                                                                                                                                                                                         | exit 0. Per-package numbers are in the table below                                                                                                                                                                                                                                                                                                                                                                          |
| 8   | `OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3427/mysql CI=1 pnpm test:integration` (MySQL 8.0.46)                                                                                                                                                | exit 0. Harness 1/1; `persistence/tenancy` 5/5; `persistence/identity` MySQL 30/30; `test:platform` 15 files / 139 tests, which includes `mysql-identity.test.ts` 6/6 on real MySQL. Composition coverage: 99.52 stmts / 97.88 branches / 98.36 funcs / 99.52 lines, gated at 95/95/95/90. With `CI=1` set, nothing was skipped                                                                                                  |
| 9   | Race repetition: 20 runs of `vitest run` over `invitation-race`, `mysql-identity`, `invitations`, `negative` and `bff` (real MySQL; 10 of the 20 with `--sequence.shuffle`)                                                                                    | **20/20 passed**                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | Store repetition: 10 runs of `packages/persistence/identity` `src/mysql.integration.test.ts` (real MySQL, two pools)                                                                                                                                         | **10/10 passed**                                                                                                                                                                                                                                                                                                                                                                                                            |
| 11  | Playwright (`e2e/`, chromium, `CI=1`, `retries: 0`), with a temporary config override for `executablePath=/opt/pw-browsers/chromium-1194/...` and port 4392                                                                                                       | **26/26 passed**. The components gallery, stories with axe, and the web shell: login, navigation, invitation, users, company, expired session, storage, axe, overflow. The stock `pnpm test:e2e` fails locally only because the installed browser build is 1194 and Playwright expects 1193; that is an environment issue, not a product issue                                                                                    |
| 12  | `pnpm audit --audit-level high`                                                                                                                                                                                                                          | exit 0 (1 low, 3 moderate; documented in the task doc at :277)                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | `gh api .../commits/a927068.../check-runs`, then `.../actions/jobs/112201531231`                                                                                                                                                                       | `quality` **success**. Every step succeeded: leak scan, install, audit, `pnpm quality`, `playwright install` and `pnpm test:e2e`. `head_sha` = `a927068`                                                                                                                                                                                                                                                                         |
| 14  | `gh api .../rulesets/24547352` (read-only)                                                                                                                                                                                                                 | `protect-main` is active on the default branch. It has `deletion`, `non_fast_forward`, `required_status_checks` (`quality`, strict) and `pull_request` with 0 required approvals. No bypass actors. This matches the task doc at :273                                                                                                                                                                                             |
| 15  | `grep` for `.only(`, `it.skip(`, `test.skip(` and `describe.skip(` across apps, packages, tests, e2e, infra and tools                                                                                                                                                         | Only the two MySQL suites use a conditional `describe.skip`, and both throw when `CI` is set and the URL is missing (`packages/persistence/identity/src/mysql.integration.test.ts:34`, `tests/integration/platform/mysql-identity.test.ts:29`)                                                                                                                                                                        |
| 16  | Mutation runs (25 mutants; scripts in my scratch directory; each mutant was reverted immediately)                                                                                                                                                               | 22 killed, 3 survived. Details below                                                                                                                                                                                                                                                                                                                                                                                       |
| 17  | Probes (throwaway `.probe/`, deleted)                                                                                                                                                                                                                      | (a) A revoked pending invitation stays dead across a suspend and reactivate. Tenant B's administrator gets 404 when targeting tenant A's pending id, and the invitation stays pending in A. B's audit trail holds none of A's ids. (b) After a suspension, an invitation issued earlier is refused and stays pending; the invitee cannot sign in. (c) A `__proto__` request header name: see I1. All probes behaved as described |

### Coverage measured by `pnpm test:unit`

| Package                                  | Tests | Stmts | Branch | Funcs | Lines | Gate        |
| ---------------------------------------- | ----- | ----- | ------ | ----- | ----- | ----------- |
| packages/contracts                       | 44    | 100   | 98.71  | 100   | 100   | 95/95/95/90 |
| packages/ui (jsdom), + axe 2             | 14    | 100   | 97.29  | 100   | 100   | 90/85       |
| apps/web                                 | 126   | 99.61 | 94.83  | 98.74 | 99.61 | 90/85       |
| packages/domain/tenants                  | 18    | 100   | 100    | 100   | 100   | 95/90       |
| packages/persistence/tenancy             | 183   | 99.75 | 97.39  | 100   | 99.75 | 95/90       |
| packages/persistence/identity            | 112   | 100   | 98.16  | 98.76 | 100   | 95/90       |
| tools/orchestrator                       | 17    | 100   | 92.73  | 100   | 100   | 90/85       |
| packages/domain/identity                 | 51    | 99.74 | 99.55  | 100   | 99.74 | 95/90       |
| packages/platform/auth                   | 7     | 100   | 100    | 100   | 100   | 95/90       |
| apps/api/auth                            | 12    | 100   | 100    | 100   | 100   | 95/90       |
| apps/api/bff                             | 77    | 100   | 99     | 100   | 100   | 95/90       |
| apps/worker/base                         | 22    | 100   | 100    | 100   | 100   | 90/85       |
| packages/platform/audit                  | 17    | 94.39 | 94.11  | 100   | 94.39 | 90/85 (L1)  |
| packages/platform/outbox                 | 21    | 98.92 | 92.55  | 100   | 98.92 | 90/85       |
| infra/queues                             | 4     | 100   | 100    | 100   | 100   | 90/85       |
| apps/api/tenants                         | 7     | 100   | 100    | 100   | 100   | 95/90       |
| packages/domain/files                    | 17    | 100   | 100    | 100   | 100   | 95/90       |
| packages/platform/files                  | 32    | 100   | 100    | 100   | 100   | 95/90       |
| apps/api/files                           | 31    | 100   | 98.64  | 100   | 100   | 95/90       |
| infra/storage                            | 5     | 100   | 100    | 100   | 100   | 90/85       |
| infra/runtime                            | 21    | 100   | 97.46  | 100   | 100   | 90/85       |
| tests/harness (tenant-key and leak scan) | 22    | 100   | 100    | 100   | 100   | 80          |

### Mutation results

All mutants were run against the suites named in the command column of my script: the platform suite, plus the BFF, store unit, store MySQL, files and leak-scan suites where relevant. "Killed" means the run exited non-zero.

| Id  | Mutation                                                                                                                   | Result                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `redeem`: drop the tenant-status check (`apps/api/composition/src/platform.ts:617-618`)                                    | Killed, 10 failures. These cover memory, BFF, TypeORM on the fake driver, real MySQL and the race tests                                                                                                                                       |
| M2  | `acceptInvitation`: call `redeem` without `locked` (`platform.ts:603-605`)                                                 | Killed, 16 failures: accept racing revoke, in both orders and on every store                                                                                                                                                               |
| M3  | Pending `removeMember`: skip `identity.revokeMembership` (`platform.ts:751`)                                               | Killed, 12 failures (including real MySQL)                                                                                                                                                                                              |
| M4  | Pending `removeMember`: skip `access.revokePending` (`platform.ts:752`)                                                    | Killed, 10 failures                                                                                                                                                                                                                       |
| M5  | Store `revokeMembership`: do not consume the invitation rows (`packages/persistence/identity/src/store.ts:572-574`)        | Killed (`store.test.ts`: "revoking a pending membership consumes its invitation and cannot be undone by a replay")                                                                                                                  |
| M6  | `effectiveRole`: ignore the stored role (`apps/api/composition/src/access.ts:155-158`)                                     | Killed, 6 failures (including real MySQL)                                                                                                                                                                                                 |
| M7b | `suspendTenant`/`reactivateTenant` without the tenant lock, still invoked (`platform.ts:482-493`)                          | Killed: both "accept racing a tenant suspension" tests fail                                                                                                                                                                         |
| M8  | `TenantGate`: drop the `tenantId` comparison (`platform.ts:149`)                                                            | **Survived** (L2)                                                                                                                                                                                                                      |
| M9  | `originAllowed`: drop the Origin/Host comparison (`apps/api/bff/src/csrf.ts:85`)                                            | Killed                                                                                                                                                                                                                              |
| M10 | `originAllowed`: drop the `Sec-Fetch-Site` check (`csrf.ts:87`)                                                             | Killed                                                                                                                                                                                                                              |
| M11 | `readCookie`: accept repeated values (`apps/api/bff/src/cookies.ts:30`)                                                    | Killed                                                                                                                                                                                                                              |
| M12 | Users cursor: no tenant binding (`apps/api/bff/src/routes.ts:217`)                                                         | Killed                                                                                                                                                                                                                              |
| M13 | Download grant: no subject binding (`apps/api/files/src/index.ts:259`)                                                      | Killed                                                                                                                                                                                                                              |
| M14 | `assertDownloadable`: the original need not be clean (`packages/domain/files/src/index.ts:237`)                            | Killed                                                                                                                                                                                                                              |
| M15 | Leak scan: an allow marker anywhere on the line suppresses the finding (`tests/harness/leak-scan.mjs`)                      | Killed                                                                                                                                                                                                                              |
| M16 | `inspectInvitation`: a suspended tenant's invitation is visible (`platform.ts:821-825`)                                    | Killed                                                                                                                                                                                                                              |
| M17 | Store `revokeMembership`: no last-administrator check (`store.ts:568-569`)                                                 | Killed, 14 failures                                                                                                                                                                                                                       |
| M18 | `hasPending` ignores the tenant (`access.ts:130-132`)                                                                       | **Survived** (L2): masked by the store's tenant-scoped `revokeMembership`                                                                                                                                                             |
| M19 | `revokePending` ignores the tenant (`access.ts:91-94`)                                                                      | **Survived** (L2): only reachable after a successful same-tenant store revocation                                                                                                                                                    |
| M20 | Pre-session routes: skip the CSRF check (`apps/api/bff/src/handler.ts:177`)                                                 | Killed                                                                                                                                                                                                                              |
| M21 | `GatedIdentityService`: skip the control-plane gate (`platform.ts:171`)                                                     | Killed, 16 failures                                                                                                                                                                                                                       |
| M22 | `TenantGate`: drop the subject comparison (`platform.ts:150`)                                                               | Killed (`sessions.test.ts`)                                                                                                                                                                                                         |
| M23 | `adminOperation`: no re-authorization inside the lock (`platform.ts:683-684`)                                               | Killed, 10 failures                                                                                                                                                                                                                       |
| M24 | Active `removeMember`: drop the directory last-admin check (`platform.ts:762-763`)                                          | Killed                                                                                                                                                                                                                              |
| M7  | First attempt at M7: replaced the lock with an uninvoked function                                                           | Not counted. It was a noisy kill (status never set, 30 failures), so I redid it as M7b                                                                                                                                                       |

## Round-1 fixes, verified independently

- **B1: removing a pending member revokes the invitation.**
  - **Code path:**
    - `Platform.removeMember` (`apps/api/composition/src/platform.ts:744-760`) takes the tenant lock and re-authorizes `manage_users` inside it. It checks that the pending invitation belongs to the caller's tenant (`hasPending`, tenant-scoped).
    - It then revokes the pending membership through the store (`IdentityService.revokeMembership`). The TypeORM adapter does this under the tenant lock row and also consumes the unconsumed invitation rows of that `(tenant_id, identity_id)` in the same transaction (`store.ts:555-581`).
    - It drops the directory entry and audits `invitation.revoked`.
  - **Effect on activation:** activation needs a `pending` membership (`store.ts:502-511`, in-memory `index.ts:245-254`), so the token is dead in both stores.
  - **Effect on the BFF:** `users.deactivate` returns 200 `{id, status:'inactive'}`. Inspecting or accepting the token afterwards gives the uniform 404.
  - **Tests and probes:** M3, M4 and M5 confirm the tests bite. My cross-tenant probe confirms that tenant B cannot revoke A's pending invitation (404) and that A's invitation stays pending.
- **B2: a suspended tenant cannot accept.**
  - `acceptInvitation` (`platform.ts:588-649`) runs `redeem` under the tenant lock and refuses a non-active tenant before touching the store, with the uniform error and nothing consumed.
  - `suspendTenant` and `reactivateTenant` take the same lock (`platform.ts:482-493`).
  - The invitation is redeemable again after reactivation, within its 72 h. This is the documented decision (task doc :249).
  - M1, M7b and M16 confirm the tests bite, and my probe (b) reproduces the behaviour.
- **BL1: the accept/revoke race.** It is serialized in-process; M2 confirms. Real MySQL with injected latency passes in both orders across 20 repetitions.
- **N2: subject comparison in `TenantGate`.** M22 is killed.
- **N3: stored role versus directory role (fail closed).** M6 is killed.

## Findings

### High

None.

### Medium

None.

### Low

- **L1. The SPECS §9.1 95/90 tier is not enforced on M1 packages that carry isolation or PII rules. `platform/audit` measures below it.**
  - **What SPECS asks:** "dominio/autorización/aislamiento/workflows 95% líneas y 90% branches" (`SPECS.md:303`).
  - **Where the gate is lower:** `package.json` `test:unit` gates the following at 90/90/90/85:
    - `packages/platform/audit`: tenant-scoped `list`, the PII allowlist and `redactError`;
    - `apps/worker/base`: rejects jobs of suspended or missing tenants;
    - `packages/platform/outbox`: deduplication per tenant;
    - `infra/storage`: per-tenant key prefixes;
    - `infra/queues`.
  - **Measured:** `platform/audit` is at 94.39% lines. The uncovered lines are `packages/platform/audit/src/index.ts:73-79`: the array and object branches of `scrub`, which nothing reaches today because `redactError` only passes a string.
  - **Documentation:** the task doc says these packages "siguen en 90/85 (fuera de este alcance)" (`docs/tasks/CORE-INTEGRATE-M1-20261006.md:219`). No owner decision is recorded, and G0 accepted them at 90/85.
  - **Fix:**
    - raise these packages to 95/95/95/90 (the other four are already at 100%);
    - delete or test the unreachable `scrub` branches;
    - or record an explicit owner exception.
- **L2. Three defense-in-depth tenant and subject checks have no test that fails without them (M8, M18, M19).**
  - **The checks:**
    - `TenantGate` compares `resolved.tenantId !== context.tenantId` (`platform.ts:149`);
    - `AccessDirectory.hasPending` checks the tenant (`access.ts:130-132`);
    - `AccessDirectory.revokePending` checks the tenant (`access.ts:91-94`).
  - **Why it is only Low:** none is exploitable today.
    - For the gate: an identity has exactly one tenant, because the external link is UNIQUE and every invitation creates a new identity.
    - For the directory checks: the store's tenant-scoped `revokeMembership(tenantId, identityId)` returns not_found first. My probe confirms the cross-tenant revoke gets 404.
  - **Why it matters:** SPECS §9.1 asks for mutation-resistant tests of permission rules. These guards would silently disappear the day an identity can belong to two tenants, or the store contract changes.
  - **Fix:** add direct unit tests, for example `AccessDirectory` with a pending invitation in A queried for B, and a gate whose control-plane mirror names another tenant.
- **L3. `AGENTS.md:18` is stale and now contradicts ADR-0009.** It still says "sin runtime/CI implementados. Seguir protocolo manual de Orchestrator hasta completar FND-ORCH y G0". G0 auditor B already reported this (`docs/audits/G0/8b1b61c.../audit-b.md:228`) and it was never fixed. ADR-0009 now records that FND-ORCH will not be pursued, so an agent following AGENTS.md literally would wait for something that will never happen. Editing it needs the owner or coordinator (shared instruction file).
- **L4. `docs/tasks/FND-DS.md:21` lists `pnpm storybook` as a package command, and no such script exists.** This is the documentary side of the Storybook deferral, which has now expired (see the preconditions).

### Info

- **I1. A `__proto__` request header name rewrites the prototype of the normalized header map.**
  - **Where:** `normalizeHeaders` (`apps/api/bff/src/http.ts:89-106`) builds the map in a plain `{}`. A header named `__proto__` is a valid header token, and Node delivers it as an own key of `headersDistinct`. Assigning `result['__proto__'] = [...]` therefore sets the map's prototype to an attacker-chosen array.
  - **Probe result:** `Object.getPrototypeOf(h)` was an array.
  - **Why it is inert:** an array of strings has no header-named properties. `origin`, `cookie` and `x-csrf-token` lookups behaved correctly in my probe.
  - **Fix:** use `Object.create(null)` or a `Map` to remove the class of bug.
- **I2. The composition's public entry re-exports the fakes.** `apps/api/composition/src/index.ts:5` (`export * from './testing.js'`) re-exports `FakeOidcVerifier`, the in-memory stores and `FakeScanner`.
  - The web side has `productionBundle.test.ts`, but nothing equivalent guards the server side. There is no server entrypoint yet (`assertStagingOnly` is not wired; documented).
  - Before one exists, move the fakes to a test-only entry or add a production-wiring guard.
- **I3. The leak-scan allow marker is lexical.** `// secret-scan:allow <reason>` or `# ...` at the end of a line is honoured even inside a string literal, and only tracked files at HEAD are scanned. Allowed lines are printed, and the limits are documented (task doc :256). M15 confirms the "marker after the value" rule is tested.
- **I4. A revoked pending invitation keeps its entry in `Platform.invitations`.** The entry for the token hash stays until the next expiry purge in `inviteUser` (`platform.ts:561-563`). This is harmless: `inspectInvitation` and `acceptInvitation` fail closed through `hasPending` and the store.
- **I5. Cross-process residuals are documented accurately.** I compared the documentation with the code. These are:
  - the in-memory tenant lock;
  - the in-memory directory, not rehydrated;
  - the tenant status coming from the in-memory control plane;
  - invitations not registered in the composition taking the unlocked path.
  - **Where they are documented:**
    - task doc :248 and :250 (FIX-G1 BL1 and B2);
    - :176 (Slice 4);
    - :79 (Slice 1).
  - No test covers the composition with two processes; this too is stated.

## Deferred and out-of-scope items: confirmed documented

I confirmed each of these in the repository and did not report any of them as a finding:

| Item                                       | Where it is documented                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS                                        | ADR-0002, ADR-0008, task doc :88 and :282, `infra/runtime/staging.json` (`awsDeferred: true`)                                                                                              |
| Real OIDC                                  | Task doc :83, :143, :206, :279                                                                                                                                                             |
| MFA and `sessionIdleHours` not enforced    | Task doc :145, :279, :280                                                                                                                                                                  |
| Rate limits                                | Task doc :84, :147, :279                                                                                                                                                                   |
| Durable queue, outbox and audit            | Task doc :86-87, :278                                                                                                                                                                      |
| Real staging                               | Task doc :88, :282, `infra/runtime/STAGING.md`                                                                                                                                             |
| FND-ORCH / orchestrator                    | ADR-0009, transcribed as the owner's decision. The repository cannot verify that decision, as ADR-0009 itself states. The open G0 orchestrator items are left latent, with no entrypoint |
| Cross-process residuals                    | See I5                                                                                                                                                                                     |

## Gate preconditions: owner or process, not code defects

None of these is a finding against the candidate, but G1 cannot be recorded as passed until each is settled.

1. **The Storybook runtime and pixel-snapshot deferral has expired.**
   - ADR-0008:21 deferred them to "antes de la primera pantalla funcional y, como máximo, a G1".
   - Functional screens exist (`apps/web/settings/access/*`, `apps/web/auth/*`).
   - The task doc records it as overdue and needing an owner extension or waiver (:275). L4 relates to this.
2. **CORE-AUDIT and CORE-AUTH acceptance needs explicit owner acceptance of the deferrals.** Durable outbox, audit and reconciliation, and OIDC/MFA/recovery over HTTP, are deferred (task doc :278-279). The deferrals themselves are in my out-of-scope list; their acceptance is the owner's call.
3. **ORCH §7.2(5), (8) and (9):**
   - the second auditor's approval on `a927068`;
   - `docs/audits/G1/a9270686.../report.md`;
   - the owner's recorded acceptance.

## Areas reviewed with no finding

- **Tenant isolation.**
  - Tenant and actor always come from the server session.
  - Composite tenant keys are used in every in-memory store and in the TypeORM entities, and invitations and sessions have tenant-scoped foreign keys.
  - The files API scopes `records.get(tenantId, id)` by tenant, and download grants are bound to tenant and subject (M13).
  - Users cursors are signed and bound to the tenant and the query (M12).
  - Audit `list(tenantId)` returns only the caller's tenant.
  - The A/B suites are `isolation`, `bff`, `directory`, `persistent-roles` and `negative`.
- **Authentication and authorization.**
  - Every call re-authenticates and re-resolves permissions.
  - `GatedIdentityService` re-checks the control plane (M21, M22).
  - Admin operations re-authorize inside the tenant lock (M23).
  - The last-administrator rule holds in the directory (M24) and under the store's lock row (M17).
  - Role changes bump the version, and a stored role that disagrees with the directory fails closed (M6).
- **Session and CSRF.**
  - Cookies are `HttpOnly; Secure; SameSite=Lax` for the session and `Strict` for the pre-login nonce, with `Path=/api`.
  - Tossed or duplicated cookies fail closed (M11).
  - The session CSRF token is an HMAC of the session token, and the pre-login token is a signed double submit (M20).
  - Origin, Host and `Sec-Fetch-Site` are enforced on every non-public state-changing route (M9, M10).
  - Login revokes the previous session and clears the cookie on 401.
- **BFF header handling.**
  - Repeated headers are treated as ambiguous.
  - The Node adapter uses `headersDistinct`; header size is capped at 8 KiB, header count at 50, and timeouts are set.
  - Body size is checked against `Content-Length` and while streaming. Strict JSON parsing rejects unknown keys.
  - URL limits apply, and route parameters use a fixed alphabet.
  - Security headers are on every response, with no CORS.
- **File pipeline.**
  - Uploads go to quarantine and are released only after a clean verdict, with a hash re-check.
  - A derivative needs a clean original of the same tenant (M14), and PII files need `view_pii`.
  - Downloads re-check the session, permissions, status and content integrity, and audit without names or hashes.
- **Migrations.** Identity migrations use their own table, `transaction:'all'` and `utf8mb4_0900_bin` on key columns, with CHECK, UNIQUE and composite foreign keys, verified in `information_schema` on MySQL 8.0.46. They migrate up, down and up again. The runtime account has no DDL. MySQL DDL is not atomic; this is documented.
- **Secrets and leak handling.**
  - No hard-coded secrets outside the marked fixtures.
  - The BFF and grant secrets must be at least 32 characters.
  - Store errors are sanitized and the BFF writes no logs.
  - The leak scan runs first in CI and inside `pnpm quality`.
- **CI and workflow hardening.**
  - Actions are pinned by SHA, with `persist-credentials: false`, `permissions: contents: read` and `timeout-minutes: 45`.
  - CI runs `pnpm audit --audit-level high` and the MySQL service, and fails hard if the MySQL URL is missing.
  - CI runs Playwright with no retries.
  - The ruleset is active with a required check and a pull-request rule.
- **Traceability and doc/code consistency.**
  - The FIX-G1 statements match the code and tests: the BFF 200 then 404 sequence, the repeat-revoke 404, the mock behaviour, the 4 allowed fixtures and the 16 routes.
  - The historical test counts in Slices 1–4 are labelled as historical.

## Cleanup

- Worktree `/tmp/g1a-r2` was removed with `git worktree remove --force`, and the worktree list was pruned.
- The `mysqld` instance was shut down and its datadir `/tmp/g1a-mysql-mXE5` deleted.
- The probe files and the Playwright override were deleted before the worktree was removed.
