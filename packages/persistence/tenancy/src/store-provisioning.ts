import {
  IdempotencyConflictError,
  opaqueId,
  opaqueTenantId,
  payloadHash,
  ProvisioningFailedError,
  type Tenant,
  type TenantId,
  type TenantProvisioningTarget,
  type TenantStatus,
} from '@opslog/domain-tenants';
import { In, MoreThan, type DataSource } from 'typeorm';
import { ProvisioningJobEntity, TenantDatabaseLocationEntity, TenantEntity } from './entities.js';
import type {
  FencedTenantProvisioningTarget,
  VerifiedTenantProvisioningAdapter,
} from './provisioning.js';
import { toTenant } from './row-mappers.js';
import { delay, isDuplicateKey, isVerifiableEvidence, safeFailureCode } from './store-helpers.js';

const MAX_PROVISIONING_ATTEMPTS = 5;
// Provisioning paths may only move a tenant between these states, so an operator's suspension is never overwritten.
const PROVISIONABLE_STATUSES: TenantStatus[] = ['provisioning', 'failed'];

/** Dependencies of the provisioning workflow, passed explicitly instead of read from the store. */
export interface TenantStoreDeps {
  readonly dataSource: DataSource;
  readonly leaseMs: number;
  readonly waitMs: number;
  getTenant(id: TenantId): Promise<Tenant | undefined>;
}

export async function createAndProvision(
  deps: TenantStoreDeps,
  request: { readonly name: string },
  idempotencyKey: string,
  adapter: VerifiedTenantProvisioningAdapter,
): Promise<Tenant> {
  const name = request.name.trim();
  if (!name || name.length > 160 || !idempotencyKey.trim() || idempotencyKey.length > 255)
    throw new Error('invalid provisioning request');
  const hash = payloadHash({ name });
  const target = await ensureProvisioningRecord(deps, name, idempotencyKey, hash);
  const owner = opaqueId();
  const claim = await claimJob(deps, target, hash, owner);
  if (claim.kind === 'succeeded') return claim.tenant;
  if (claim.kind === 'exhausted') throw new ProvisioningFailedError('ATTEMPTS_EXHAUSTED');
  if (claim.kind === 'blocked') throw new ProvisioningFailedError('TENANT_NOT_PROVISIONABLE');
  if (claim.kind === 'busy') return waitForProvisioning(deps, target, hash, adapter);
  return runProvisioning(deps, fencedTarget(deps, target, claim.attempt, owner), hash, adapter);
}

export async function ensureProvisioningRecord(
  deps: TenantStoreDeps,
  name: string,
  idempotencyKey: string,
  hash: string,
): Promise<TenantProvisioningTarget> {
  const jobs = deps.dataSource.getRepository(ProvisioningJobEntity);
  const existing = await jobs.findOneBy({ idempotencyKey });
  if (existing) {
    if (existing.payloadHash !== hash) throw new IdempotencyConflictError();
    const tenant = await deps.dataSource
      .getRepository(TenantEntity)
      .findOneBy({ id: existing.tenantId });
    if (!tenant) throw new ProvisioningFailedError();
    return findTarget(deps, existing.tenantId);
  }
  const id = opaqueTenantId();
  const now = new Date();
  const location: TenantProvisioningTarget = {
    tenantId: id,
    databaseName: `opslog_t_${id.replaceAll('-', '')}`,
    credentialRef: `tenant/${opaqueId()}/runtime`,
    secretVersion: 1,
  };
  try {
    await deps.dataSource.transaction(async (manager) => {
      await manager.getRepository(TenantEntity).insert({
        id,
        name,
        status: 'provisioning',
        createdAt: now,
      });
      await manager.getRepository(TenantDatabaseLocationEntity).insert({
        ...location,
        migrationVersion: null,
        runtimeRoleVerified: false,
        isolationProbeVerified: false,
        verifiedAt: null,
      });
      await manager.getRepository(ProvisioningJobEntity).insert({
        id: opaqueId(),
        idempotencyKey,
        tenantId: id,
        payloadHash: hash,
        status: 'pending',
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      });
    });
    return location;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await jobs.findOneBy({ idempotencyKey });
    if (!raced || raced.payloadHash !== hash) throw new IdempotencyConflictError();
    return findTarget(deps, raced.tenantId);
  }
}

export async function findTarget(
  deps: TenantStoreDeps,
  tenantId: string,
): Promise<TenantProvisioningTarget> {
  const location = await deps.dataSource
    .getRepository(TenantDatabaseLocationEntity)
    .findOneBy({ tenantId });
  if (!location) throw new ProvisioningFailedError();
  return {
    tenantId: tenantId as TenantId,
    databaseName: location.databaseName,
    credentialRef: location.credentialRef,
    secretVersion: location.secretVersion,
  };
}

export function fencedTarget(
  deps: TenantStoreDeps,
  target: TenantProvisioningTarget,
  attempt: number,
  leaseOwner: string,
): FencedTenantProvisioningTarget {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ProvisioningFailedError();
  const tenantKey = target.tenantId.replaceAll('-', '');
  return {
    ...target,
    databaseName: `opslog_t_${tenantKey}_a${attempt}`,
    credentialRef: `tenant/${target.tenantId}/attempt/${attempt}/runtime`,
    secretVersion: attempt,
    attempt,
    leaseOwner,
  };
}

export async function claimJob(
  deps: TenantStoreDeps,
  target: TenantProvisioningTarget,
  hash: string,
  owner: string,
): Promise<
  | { kind: 'claimed'; attempt: number }
  | { kind: 'busy' }
  | { kind: 'exhausted' }
  | { kind: 'blocked' }
  | { kind: 'succeeded'; tenant: Tenant }
> {
  return deps.dataSource.transaction(async (manager) => {
    const jobs = manager.getRepository(ProvisioningJobEntity);
    const job = await jobs.findOne({
      where: { tenantId: target.tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!job || job.payloadHash !== hash) throw new IdempotencyConflictError();
    if (job.status === 'succeeded') {
      const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
      if (row?.status === 'active') return { kind: 'succeeded', tenant: toTenant(row) };
      throw new ProvisioningFailedError();
    }
    const now = new Date();
    if (job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt > now) return { kind: 'busy' };
    // A tenant an operator suspended is not provisioned further: no attempt is consumed and no resources are created.
    const tenantRow = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
    if (tenantRow && !PROVISIONABLE_STATUSES.includes(tenantRow.status)) return { kind: 'blocked' };
    // Every attempt provisions its own database and credential; cap them so a persistent failure
    // cannot create unbounded orphaned resources.
    if (job.attempt >= MAX_PROVISIONING_ATTEMPTS) {
      job.status = 'failed';
      job.errorCode = 'ATTEMPTS_EXHAUSTED';
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now;
      await jobs.save(job);
      await manager
        .getRepository(TenantEntity)
        .update({ id: target.tenantId, status: In(PROVISIONABLE_STATUSES) }, { status: 'failed' });
      return { kind: 'exhausted' };
    }
    job.status = 'running';
    job.attempt += 1;
    job.leaseOwner = owner;
    job.leaseExpiresAt = new Date(now.getTime() + deps.leaseMs);
    job.errorCode = null;
    job.updatedAt = now;
    await jobs.save(job);
    await manager
      .getRepository(TenantEntity)
      .update(
        { id: target.tenantId, status: In(PROVISIONABLE_STATUSES) },
        { status: 'provisioning' },
      );
    return { kind: 'claimed', attempt: job.attempt };
  });
}

export async function waitForProvisioning(
  deps: TenantStoreDeps,
  target: TenantProvisioningTarget,
  hash: string,
  adapter: VerifiedTenantProvisioningAdapter,
): Promise<Tenant> {
  const deadline = Date.now() + deps.waitMs;
  while (Date.now() < deadline) {
    await delay(50);
    const job = await deps.dataSource
      .getRepository(ProvisioningJobEntity)
      .findOneBy({ tenantId: target.tenantId });
    if (!job || job.payloadHash !== hash) throw new IdempotencyConflictError();
    if (job.status === 'succeeded') {
      const tenant = await deps.getTenant(target.tenantId);
      if (tenant?.status === 'active') return tenant;
    }
    const owner = opaqueId();
    const result = await claimJob(deps, target, hash, owner);
    if (result.kind === 'succeeded') return result.tenant;
    if (result.kind === 'exhausted') throw new ProvisioningFailedError('ATTEMPTS_EXHAUSTED');
    if (result.kind === 'blocked') throw new ProvisioningFailedError('TENANT_NOT_PROVISIONABLE');
    if (result.kind === 'claimed') {
      return runProvisioning(
        deps,
        fencedTarget(deps, target, result.attempt, owner),
        hash,
        adapter,
      );
    }
  }
  throw new ProvisioningFailedError();
}

export async function attemptOutcome(
  deps: TenantStoreDeps,
  target: TenantProvisioningTarget,
  attempt: number,
): Promise<
  { kind: 'succeeded'; tenant: Tenant } | { kind: 'not_succeeded' } | { kind: 'unknown' }
> {
  try {
    return await deps.dataSource.transaction(async (manager) => {
      const job = await manager.getRepository(ProvisioningJobEntity).findOne({
        where: { tenantId: target.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (job?.attempt !== attempt || job.status !== 'succeeded')
        return { kind: 'not_succeeded' } as const;
      // This attempt's commit landed. Decide on job state alone: even if an operator has since
      // changed the tenant status, its database and credential are live and must not be dropped.
      const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
      return row?.status === 'active'
        ? ({ kind: 'succeeded', tenant: toTenant(row) } as const)
        : ({ kind: 'unknown' } as const);
    });
  } catch {
    return { kind: 'unknown' };
  }
}

export async function runProvisioning(
  deps: TenantStoreDeps,
  target: FencedTenantProvisioningTarget,
  hash: string,
  adapter: VerifiedTenantProvisioningAdapter,
): Promise<Tenant> {
  const { leaseOwner: owner, attempt } = target;
  const timer = setInterval(
    () => {
      void deps.dataSource
        .getRepository(ProvisioningJobEntity)
        .update(
          {
            tenantId: target.tenantId,
            leaseOwner: owner,
            attempt,
            status: 'running',
            leaseExpiresAt: MoreThan(new Date()),
          },
          { leaseExpiresAt: new Date(Date.now() + deps.leaseMs), updatedAt: new Date() },
        )
        .catch(() => undefined);
    },
    Math.max(1000, Math.floor(deps.leaseMs / 3)),
  );
  timer.unref();
  try {
    const evidence = await adapter.provision(target);
    if (!isVerifiableEvidence(target, evidence)) throw new ProvisioningFailedError();
    const tenant = await deps.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(ProvisioningJobEntity);
      const job = await jobs.findOne({
        where: { tenantId: target.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !job ||
        job.leaseOwner !== owner ||
        job.attempt !== attempt ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= Date.now() ||
        job.payloadHash !== hash ||
        job.status !== 'running'
      )
        throw new ProvisioningFailedError();
      const location = manager.getRepository(TenantDatabaseLocationEntity);
      await location.update(
        { tenantId: target.tenantId },
        {
          databaseName: target.databaseName,
          credentialRef: target.credentialRef,
          secretVersion: target.secretVersion,
          migrationVersion: evidence.migrationVersion,
          runtimeRoleVerified: evidence.runtimeRoleVerified,
          isolationProbeVerified: evidence.isolationProbeVerified,
          verifiedAt: evidence.verifiedAt,
        },
      );
      await manager
        .getRepository(TenantEntity)
        .update({ id: target.tenantId, status: 'provisioning' }, { status: 'active' });
      job.status = 'succeeded';
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      job.updatedAt = new Date();
      await jobs.save(job);
      const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
      if (!row || row.status !== 'active') throw new ProvisioningFailedError();
      return toTenant(row);
    });
    return tenant;
  } catch (error) {
    const failureCode = safeFailureCode(error);
    // The commit may have succeeded with a lost acknowledgement. Never roll back an attempt that is
    // already `succeeded`, and never roll back when its state cannot be proven.
    const outcome = await attemptOutcome(deps, target, attempt);
    if (outcome.kind === 'succeeded') return outcome.tenant;
    if (outcome.kind === 'unknown') throw new ProvisioningFailedError(failureCode);
    try {
      await adapter.rollback(target);
    } catch {
      // Failed cleanup leaves the tenant inaccessible; each attempt uses its own opaque database and
      // credential names, so a retry never reuses or deletes these resources.
    }
    await deps.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(ProvisioningJobEntity);
      const job = await jobs.findOne({
        where: { tenantId: target.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (job?.leaseOwner === owner && job.attempt === attempt && job.status === 'running') {
        job.status = 'failed';
        job.errorCode = failureCode;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.updatedAt = new Date();
        await jobs.save(job);
        await manager
          .getRepository(TenantEntity)
          .update(
            { id: target.tenantId, status: In(PROVISIONABLE_STATUSES) },
            { status: 'failed' },
          );
        await manager.getRepository(TenantDatabaseLocationEntity).update(
          { tenantId: target.tenantId },
          {
            migrationVersion: null,
            runtimeRoleVerified: false,
            isolationProbeVerified: false,
            verifiedAt: null,
          },
        );
      }
    });
    throw new ProvisioningFailedError(failureCode);
  } finally {
    clearInterval(timer);
  }
}
