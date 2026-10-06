import 'reflect-metadata';
import {
  Between,
  IsNull,
  LessThan,
  MoreThan,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from 'typeorm';
import {
  expiryKeyOf,
  isDocumentType,
  isOwnerType,
  type Document,
  type DocumentFilter,
  type DocumentRevision,
  type DocumentRevisionSlice,
  type DocumentSlice,
  type DocumentStore,
  type DocumentWindow,
} from '../../../domain/documents/src/index.js';
import { DOCUMENTS_RUNTIME_ACCOUNT } from './data-source.js';
import { DocumentEntity, DocumentRevisionEntity } from './entities.js';
import {
  DocumentStoreError,
  isLockContention,
  sanitizeStoreError,
  type DocumentStoreErrorCode,
} from './errors.js';

/** Structured report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: DocumentStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmDocumentStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

/** Exactly one typed owner column is set and agrees with `ownerType`; anything else is corrupt. */
function ownerOf(row: DocumentEntity): { ownerType: Document['ownerType']; ownerId: string } {
  if (!isOwnerType(row.ownerType)) throw new DocumentStoreError('integrity');
  const ownerId = row.ownerType === 'vehicle' ? row.vehicleId : row.employeeId;
  const other = row.ownerType === 'vehicle' ? row.employeeId : row.vehicleId;
  if (ownerId === null || other !== null) throw new DocumentStoreError('integrity');
  return { ownerType: row.ownerType, ownerId };
}

const toDocument = (row: DocumentEntity): Document => {
  const owner = ownerOf(row);
  if (
    !isDocumentType(owner.ownerType, row.typeCode) ||
    row.expiryKey !== expiryKeyOf(row.expiresOn)
  )
    throw new DocumentStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...owner,
    typeCode: row.typeCode,
    title: row.title,
    notes: row.notes,
    revision: row.revision,
    issuedOn: row.issuedOn,
    expiresOn: row.expiresOn,
    documentNumber: row.documentNumber,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
};

const toRevision = (row: DocumentRevisionEntity): DocumentRevision => ({
  tenantId: row.tenantId,
  documentId: row.documentId,
  revision: row.revision,
  issuedOn: row.issuedOn,
  expiresOn: row.expiresOn,
  documentNumber: row.documentNumber,
  actorId: row.actorId,
  at: row.at.toISOString(),
});

/** Columns that can change after creation (never the tenant, the id, the owner, the type or `createdAt`). */
const mutableColumns = (document: Document) => ({
  title: document.title,
  notes: document.notes,
  revision: document.revision,
  issuedOn: document.issuedOn,
  expiresOn: document.expiresOn,
  expiryKey: expiryKeyOf(document.expiresOn),
  documentNumber: document.documentNumber,
  version: document.version,
  updatedAt: new Date(document.updatedAt),
  archivedAt: document.archivedAt === null ? null : new Date(document.archivedAt),
});

const toDocumentRow = (document: Document): DocumentEntity => ({
  tenantId: document.tenantId,
  id: document.id,
  ownerType: document.ownerType,
  vehicleId: document.ownerType === 'vehicle' ? document.ownerId : null,
  employeeId: document.ownerType === 'employee' ? document.ownerId : null,
  typeCode: document.typeCode,
  createdAt: new Date(document.createdAt),
  ...mutableColumns(document),
});

const toRevisionRow = (revision: DocumentRevision): DocumentRevisionEntity => ({
  tenantId: revision.tenantId,
  documentId: revision.documentId,
  revision: revision.revision,
  issuedOn: revision.issuedOn,
  expiresOn: revision.expiresOn,
  documentNumber: revision.documentNumber,
  actorId: revision.actorId,
  at: new Date(revision.at),
});

/** The expiry-key condition of a derived status (see `matchesExpiry` in the domain). */
function expiryCondition(expiry: NonNullable<DocumentFilter['expiry']>) {
  if (expiry.status === 'expired') return LessThan(expiry.from);
  if (expiry.status === 'expiring') return Between(expiry.from, expiry.until);
  return MoreThan(expiry.until);
}

/**
 * Persistent TypeORM/MySQL implementation of the `DocumentStore` port.
 *
 * - Every statement names `company_id`: the primary key, every index and every filter start with
 *   it, so a row of another company is unreachable, not merely hidden.
 * - A document change and its revision row are one READ COMMITTED transaction. Revision rows are
 *   only ever inserted: the original validity data is never rewritten.
 * - Concurrency is optimistic: `replace` is a single conditional UPDATE on
 *   `(company_id, id, version)`; of two writers holding the same version, exactly one affects a row.
 * - Driver errors never leave this class: everything becomes the sanitized `DocumentStoreError`
 *   (no SQL, no parameters).
 */
export class TypeOrmDocumentStore implements DocumentStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmDocumentStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Document store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !DOCUMENTS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Document store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof DocumentStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  private async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw this.fail(operation, error);
      }
    }
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  public async insert(document: Document, revision: DocumentRevision): Promise<void> {
    await this.transaction('insert', async (manager) => {
      await manager.getRepository(DocumentEntity).insert(toDocumentRow(document));
      await manager.getRepository(DocumentRevisionEntity).insert(toRevisionRow(revision));
    });
  }

  public async find(tenantId: string, id: string): Promise<Document | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(DocumentEntity).findOneBy({ tenantId, id });
      return row ? toDocument(row) : null;
    });
  }

  public async list(
    tenantId: string,
    filter: DocumentFilter,
    window: DocumentWindow,
  ): Promise<DocumentSlice> {
    return this.single('list', async () => {
      // An owner id only means something together with its type (it picks the column).
      if (filter.ownerId !== undefined && filter.ownerType === undefined)
        throw new DocumentStoreError('internal');
      const where: FindOptionsWhere<DocumentEntity> = {
        tenantId,
        ...(filter.ownerType === undefined ? {} : { ownerType: filter.ownerType }),
        ...(filter.ownerId === undefined
          ? {}
          : filter.ownerType === 'vehicle'
            ? { vehicleId: filter.ownerId }
            : { employeeId: filter.ownerId }),
        ...(filter.typeCode === undefined ? {} : { typeCode: filter.typeCode }),
        ...(filter.expiry === undefined ? {} : { expiryKey: expiryCondition(filter.expiry) }),
        ...(filter.includeArchived ? {} : { archivedAt: IsNull() }),
      };
      const [rows, total] = await this.dataSource.getRepository(DocumentEntity).findAndCount({
        where,
        order: { expiryKey: 'ASC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toDocument), total };
    });
  }

  public async replace(
    next: Document,
    expectedVersion: number,
    revision?: DocumentRevision,
  ): Promise<boolean> {
    return this.transaction('replace', async (manager) => {
      const result = await manager
        .getRepository(DocumentEntity)
        .update(
          { tenantId: next.tenantId, id: next.id, version: expectedVersion },
          mutableColumns(next),
        );
      if (result.affected !== 1) return false;
      if (revision)
        await manager.getRepository(DocumentRevisionEntity).insert(toRevisionRow(revision));
      return true;
    });
  }

  public async revisions(
    tenantId: string,
    documentId: string,
    window: DocumentWindow,
  ): Promise<DocumentRevisionSlice> {
    return this.single('revisions', async () => {
      const [rows, total] = await this.dataSource
        .getRepository(DocumentRevisionEntity)
        .findAndCount({
          where: { tenantId, documentId },
          order: { revision: 'DESC' },
          take: window.limit,
          skip: window.offset,
        });
      return { items: rows.map(toRevision), total };
    });
  }
}
