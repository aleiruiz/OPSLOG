import {
  EnvelopePiiCipher,
  LocalDevKms,
  type PiiCipher,
} from '../../../../../packages/platform/pii/src/index.js';
import type { PlatformAdapters } from './types.js';

/**
 * The cipher for sealed personal data. A persistent store with the throwaway local KMS would seal
 * rows that cannot be opened after a restart (and would put real data under a dev key): with a
 * persistent employee or incident adapter the cipher must be chosen explicitly.
 */
export function resolvePiiCipher(adapters: PlatformAdapters): PiiCipher {
  if (adapters.employees && !adapters.pii)
    throw new Error('adapters.employees requires adapters.pii (no local KMS fallback)');
  if (adapters.incidentChildren && !adapters.pii)
    throw new Error('adapters.incidentChildren requires adapters.pii (no local KMS fallback)');
  return (
    adapters.pii ??
    new EnvelopePiiCipher(LocalDevKms.ephemeral(process.env['OPSLOG_ENV'] ?? 'development'))
  );
}
