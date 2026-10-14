import { AUDIT_ENTITIES } from '../../../../../packages/persistence/audit/src/index.js';
import {
  controlPlaneSchema,
  createIdentityMigrationDataSource,
  runIdentityMigrations,
} from '../../../../../packages/persistence/identity/src/index.js';

/**
 * The identity database also holds the control plane. The audit tables are installed beforehand
 * by the audit migrator (`runFleetAuditMigrations`), so only their entities are registered here.
 */
export const identityControlSchema = {
  additionalEntities: [...AUDIT_ENTITIES, ...controlPlaneSchema.additionalEntities],
  additionalMigrations: controlPlaneSchema.additionalMigrations,
} as const;

export interface IdentityMigrationCredentials {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Schema-owning credentials; never given to a runtime store. */
  readonly username: string;
  readonly password: string;
}

/** Creates (idempotently) the identity tables and the control-plane tables with the schema owner. */
export async function runIdentityControlMigrations(
  credentials: IdentityMigrationCredentials,
): Promise<void> {
  const source = createIdentityMigrationDataSource({ ...credentials, ...identityControlSchema });
  try {
    await source.initialize();
    await runIdentityMigrations(source);
    if (await source.showMigrations()) throw new Error('identity migration remains pending');
  } finally {
    if (source.isInitialized) await source.destroy();
  }
}
