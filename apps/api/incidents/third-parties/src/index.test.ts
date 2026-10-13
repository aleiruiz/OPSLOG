import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import { EVIDENCE_MAX_BYTES } from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import {
  MANAGER,
  TENANT_A,
  TENANT_B,
  setupChildren,
} from '../../../../../packages/domain/incidents/third-parties/src/test-support.js';
import { IncidentChildApi } from './index.js';

const SUBJECT = MANAGER.subject;
const META = { category: 'photo', stage: 'on_site', name: 'foto.jpg', contentType: 'image/jpeg' };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function world() {
  const base = setupChildren();
  const sessions = new Map<string, { tenantId: string; permissions: readonly string[] }>();
  const denials: string[] = [];
  const audits: { action: string; entityId: string }[] = [];
  const reads: string[] = [];
  const api = new IncidentChildApi({
    thirdParties: base.thirdParties,
    evidence: base.evidence,
    authorize: async (token, correlationId) => {
      const session = sessions.get(token);
      if (!session) throw Object.assign(new Error('x'), { code: 'unauthorized' });
      const context: TenantContext = {
        tenantId: session.tenantId,
        actor: { subject: SUBJECT, kind: 'user' },
        authorizationVersion: 1,
        correlationId,
      };
      return { context, permissions: session.permissions as never };
    },
    mechanicLinked: async () => false,
    labels: { member: async () => 'Responsable' },
    deny: async (_context, action) => {
      denials.push(action);
    },
    audit: async (_context, action, entityId) => {
      audits.push({ action, entityId });
    },
    files: {
      read: async (_token, _correlationId, fileId) => {
        reads.push(fileId);
        return base.files.bytes.get(fileId) ?? new Uint8Array();
      },
    },
  });
  const edit = ['incidents:view', 'incidents:create', 'incidents:edit'];
  sessions.set('manager', { tenantId: TENANT_A, permissions: [...edit, 'view_pii'] });
  sessions.set('restricted', { tenantId: TENANT_A, permissions: edit });
  sessions.set('other', { tenantId: TENANT_B, permissions: [...edit, 'view_pii'] });
  return { ...base, api, denials, audits, reads };
}

describe('IncidentChildApi third parties', () => {
  it('creates, edits, lists and removes, restricting identity without view_pii', async () => {
    const w = world();
    const incident = await w.draft();
    const created = await w.api.createThirdParty('manager', 'c1', incident.id, {
      version: 1,
      kind: 'person',
      name: 'Marta Sintetica',
    });
    expect(created.value).toMatchObject({ version: 2, item: { name: 'Marta Sintetica' } });
    const partyId = created.value?.item.id as string;
    const edited = await w.api.updateThirdParty('manager', 'c2', incident.id, partyId, {
      version: 2,
      injuries: true,
    });
    expect(edited.value?.version).toBe(3);
    const open = await w.api.listThirdParties('manager', 'c3', incident.id);
    expect(open.value?.identityRestricted).toBe(false);
    const restricted = await w.api.listThirdParties('restricted', 'c4', incident.id);
    expect(restricted.value?.identityRestricted).toBe(true);
    expect(JSON.stringify(restricted.value)).not.toContain('Marta');
    const removed = await w.api.removeThirdParty('manager', 'c5', incident.id, partyId, {
      version: 3,
    });
    expect(removed.value).toEqual({ version: 4 });
  });

  it('answers safe errors and audits refusals', async () => {
    const w = world();
    const incident = await w.draft();
    expect((await w.api.listThirdParties('nobody', 'c', incident.id)).error?.code).toBe(
      'unauthorized',
    );
    const hidden = await w.api.listThirdParties('other', 'c', incident.id);
    expect(hidden.error).toMatchObject({ code: 'not_found', status: 404 });
    expect(w.denials).toEqual(['incident.access_denied']);
    const bad = await w.api.createThirdParty('manager', 'c', incident.id, {
      version: 1,
      kind: 'x',
    });
    expect(bad.error).toMatchObject({ code: 'invalid_input', status: 400 });
  });
});

describe('IncidentChildApi evidence', () => {
  it('uploads, lists without internal ids, downloads with audit and detaches', async () => {
    const w = world();
    const incident = await w.draft();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const up = await w.api.uploadEvidence(
      'manager',
      'c1',
      incident.id,
      { version: 1, ...META, contentBase64: b64(bytes) },
      'evidence-key-1',
    );
    expect(up.ok, JSON.stringify(up.error)).toBe(true);
    expect(JSON.stringify(up.value)).not.toMatch(/fileId|sha|storage/i);
    expect(up.value?.item.attachedBy.displayName).toBe('Responsable');
    const evidenceId = up.value?.item.id as string;
    const pending = await w.api.evidenceContent('manager', 'c2', incident.id, evidenceId);
    expect(pending.error?.code).toBe('invalid_transition');
    expect(w.audits).toEqual([]);
    const fileId = [...w.files.records.keys()][0]?.split('/')[1] as string;
    w.files.setStatus(TENANT_A, fileId, 'clean');
    const content = await w.api.evidenceContent('manager', 'c3', incident.id, evidenceId);
    expect(content.value).toMatchObject({ contentType: 'image/jpeg', contentBase64: b64(bytes) });
    expect(w.audits).toEqual([{ action: 'incident.evidence_downloaded', entityId: incident.id }]);
    const list = await w.api.listEvidence('manager', 'c4', incident.id);
    expect(list.value).toHaveLength(1);
    const detached = await w.api.detachEvidence('manager', 'c5', incident.id, evidenceId, {
      version: up.value?.version,
    });
    expect(detached.value).toEqual({ version: 3 });
  });

  it('reads no byte when the download audit fails', async () => {
    const w = world();
    const incident = await w.draft();
    const up = await w.api.uploadEvidence('manager', 'c1', incident.id, {
      version: 1,
      ...META,
      contentBase64: b64(new Uint8Array([1, 2, 3])),
    });
    const fileId = [...w.files.records.keys()][0]?.split('/')[1] as string;
    w.files.setStatus(TENANT_A, fileId, 'clean');
    const failing = new IncidentChildApi({
      ...(w.api as unknown as { deps: ConstructorParameters<typeof IncidentChildApi>[0] }).deps,
      audit: async () => {
        throw new Error('audit down');
      },
    });
    const result = await failing.evidenceContent(
      'manager',
      'c',
      incident.id,
      up.value?.item.id as string,
    );
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    expect(w.reads).toEqual([]);
  });

  it('refuses malformed, empty or oversized base64 before storing anything', async () => {
    const w = world();
    const incident = await w.draft();
    const send = (input: unknown) => w.api.uploadEvidence('manager', 'c', incident.id, input);
    for (const input of [
      null,
      [],
      'x',
      { version: 1, ...META },
      { version: 1, ...META, contentBase64: 7 },
      { version: 1, ...META, contentBase64: '' },
      { version: 1, ...META, contentBase64: 'abc' },
      { version: 1, ...META, contentBase64: '****' },
      { version: 1, ...META, contentBase64: 'AAAA'.repeat(Math.ceil(EVIDENCE_MAX_BYTES / 3) + 10) },
      { version: 1, ...META, contentBase64: 'AAAA'.repeat(Math.ceil(EVIDENCE_MAX_BYTES / 3)) },
    ])
      expect((await send(input)).error?.code).toBe('invalid_input');
    expect(w.files.records.size).toBe(0);
  });
});
