import { createHash } from 'node:crypto';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../platform/pii/src/index.js';
import { IncidentError } from '../../cases/src/index.js';
import {
  MANAGER,
  NOW,
  OTHER_REPORTER,
  REPORTER,
  TENANT_A,
  TENANT_B,
  VEHICLE,
  actorOf,
  setup,
} from '../../cases/src/test-support.js';
import { EvidenceService } from './evidence.js';
import { IdentityVault } from './pii.js';
import { InMemoryIncidentChildStore } from './store.js';
import { ThirdPartyService } from './third-parties.js';
import type { FileLifecycle, FileRecordRef, IncidentFiles } from './types.js';

export { MANAGER, NOW, OTHER_REPORTER, REPORTER, TENANT_A, TENANT_B, VEHICLE, actorOf };

/** A reader with `incidents:view` and the generic `view_pii`. */
export const PII_READER = actorOf('00000000-0000-4000-8000-0000000000a1', [
  'view_pii',
  'incidents:view',
  'incidents:edit',
]);
/** An editor of cases without `view_pii`. */
export const EDITOR = actorOf('00000000-0000-4000-8000-0000000000a2', [
  'incidents:view',
  'incidents:edit',
]);
export const VIEWER = actorOf('00000000-0000-4000-8000-0000000000a3', ['incidents:view']);
/** What a fleet editor had before ADR-0014: generic verbs only. */
export const GENERIC_EDITOR = actorOf('00000000-0000-4000-8000-0000000000a4', [
  'view',
  'create',
  'edit',
  'view_pii',
]);

export const PARTY = {
  kind: 'person',
  name: 'Marta Sintética Ruiz',
  contact: '+52 55 0000 1234',
  plates: 'ZZZ-999-X',
  policyNumber: 'POL-TERCERO-77',
  insurerName: 'Aseguradora Tercera',
  damageDescription: 'Golpe en puerta izquierda',
  injuries: false,
} as const;
export const PROTECTED_VALUES = [PARTY.name, PARTY.contact, PARTY.plates, PARTY.policyNumber];

/** The files module as the case uses it, with a controllable lifecycle. */
export class FakeFiles implements IncidentFiles {
  public readonly records = new Map<string, FileRecordRef>();
  public readonly bytes = new Map<string, Uint8Array>();
  public reject = false;
  private n = 0;
  public async record(tenantId: string, fileId: string) {
    return this.records.get(`${tenantId}/${fileId}`) ?? null;
  }
  public add(
    tenantId: string,
    actorId: string,
    status: FileLifecycle = 'pending_scan',
    id?: string,
  ) {
    const fileId = id ?? `file-${++this.n}`;
    this.records.set(`${tenantId}/${fileId}`, {
      id: fileId,
      status,
      kind: 'original',
      sensitivity: 'standard',
      createdBy: actorId,
      displayName: `${fileId}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    return fileId;
  }
  public setStatus(tenantId: string, fileId: string, status: FileLifecycle) {
    const record = this.records.get(`${tenantId}/${fileId}`) as FileRecordRef;
    this.records.set(`${tenantId}/${fileId}`, { ...record, status });
  }
  public async ingest(
    tenantId: string,
    actorId: string,
    _correlationId: string,
    input: { name: string; contentType: string; bytes: Uint8Array },
  ) {
    if (this.reject) throw new IncidentError('invalid_input', [{ field: 'file', code: 'invalid' }]);
    const id = this.add(tenantId, actorId);
    this.bytes.set(id, input.bytes);
    return { id };
  }
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function setupChildren(now: () => Date = () => NOW) {
  const base = setup(now);
  const children = new InMemoryIncidentChildStore(base.store);
  const cipher = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
  const files = new FakeFiles();
  let n = 0;
  const options = { now, newId: () => `child-${++n}` };
  const thirdParties = new ThirdPartyService(
    base.store,
    children,
    new IdentityVault(cipher),
    options,
  );
  const evidence = new EvidenceService(base.store, children, files, options);
  /** A draft in tenant A owned by the manager. */
  const draft = () =>
    base.service.create(TENANT_A, MANAGER, { vehicleId: VEHICLE, type: 'collision' });
  return { ...base, children, cipher, files, thirdParties, evidence, draft };
}
