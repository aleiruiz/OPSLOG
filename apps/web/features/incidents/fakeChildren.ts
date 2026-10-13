import type { BffIncidentEvidence } from '@opslog/contracts';
import { FAKE_NOW, ME } from './fakeIncident';
import { fail, isFailure, ok, omit, type FakeContext } from './fakeContext';
import type { IncidentPorts } from './ports';

/** Third parties, evidence and the vehicle status change of the in-memory stand-in (component tests and the shell mock only). */
export function createFakeChildren(
  ctx: FakeContext,
): Pick<IncidentPorts, 'thirdParties' | 'evidence' | 'vehicles'> {
  return {
    thirdParties: {
      list: (id) => {
        const failed = ctx.injected('thirdParties.list');
        if (failed) return Promise.resolve(failed);
        const record = ctx.visible(id);
        if (!record) return Promise.resolve(fail(404, 'not_found'));
        const pii = ctx.viewPii();
        return Promise.resolve(
          ok({
            identityRestricted: !pii,
            items: record.parties.map((party) => ({
              ...omit(party, 'secret'),
              identityRestricted: !pii,
              ...(pii ? party.secret : {}),
            })),
          }),
        );
      },
      create: (id, body) => {
        const failed = ctx.injected('thirdParties.create');
        if (failed) return Promise.resolve(failed);
        const record = ctx.guard(id, body.version);
        if (isFailure(record)) return Promise.resolve(record);
        const party = {
          id: `party-${record.parties.length + 1}`,
          kind: body.kind,
          insurerName: body.insurerName ?? null,
          damageDescription: body.damageDescription ?? null,
          injuries: body.injuries ?? false,
          identityRestricted: false,
          createdAt: FAKE_NOW,
          updatedAt: FAKE_NOW,
          secret: {
            name: body.name ?? null,
            contact: body.contact ?? null,
            plates: body.plates ?? null,
            policyNumber: body.policyNumber ?? null,
          },
        };
        record.parties.push(party);
        ctx.entry(record, 'third_party_added', ['kind']);
        const next = ctx.commit(record, {});
        const item = omit(party, 'secret');
        return Promise.resolve(ok({ version: next.version, item }));
      },
      update: (id, partyId, body) => {
        const failed = ctx.injected('thirdParties.update');
        if (failed) return Promise.resolve(failed);
        const record = ctx.guard(id, body.version);
        if (isFailure(record)) return Promise.resolve(record);
        const party = record.parties.find((item) => item.id === partyId);
        if (!party) return Promise.resolve(fail(404, 'not_found'));
        const { name, contact, plates, policyNumber, ...plain } = omit(body, 'version');
        Object.assign(party, plain);
        party.secret = {
          name: name === undefined ? party.secret.name : name,
          contact: contact === undefined ? party.secret.contact : contact,
          plates: plates === undefined ? party.secret.plates : plates,
          policyNumber: policyNumber === undefined ? party.secret.policyNumber : policyNumber,
        };
        ctx.entry(record, 'third_party_updated', Object.keys(plain));
        const next = ctx.commit(record, {});
        const item = omit(party, 'secret');
        return Promise.resolve(ok({ version: next.version, item }));
      },
      remove: (id, partyId, version) => {
        const failed = ctx.injected('thirdParties.remove');
        if (failed) return Promise.resolve(failed);
        const record = ctx.guard(id, version);
        if (isFailure(record)) return Promise.resolve(record);
        record.parties = record.parties.filter((item) => item.id !== partyId);
        ctx.entry(record, 'third_party_removed', ['removedAt']);
        return Promise.resolve(ok({ version: ctx.commit(record, {}).version }));
      },
    },
    evidence: {
      list: (id) => {
        const failed = ctx.injected('evidence.list');
        if (failed) return Promise.resolve(failed);
        const record = ctx.visible(id);
        return Promise.resolve(record ? ok({ items: record.evidence }) : fail(404, 'not_found'));
      },
      upload: (id, body, key) => {
        const failed = ctx.injected('evidence.upload');
        if (failed) return Promise.resolve(failed);
        const record = ctx.guard(id, body.version);
        if (isFailure(record)) return Promise.resolve(record);
        const earlier = record.evidence.find((item) => item.id === `ev-${key}`);
        if (earlier)
          return Promise.resolve(ok({ version: record.incident.version, item: earlier }));
        const item: BffIncidentEvidence = {
          id: `ev-${key}`,
          category: body.category,
          stage: body.stage,
          capturedAt: body.capturedAt ?? null,
          clientCompressed: body.clientCompressed ?? false,
          displayName: body.name,
          contentType: body.contentType,
          sizeBytes: Math.floor((body.contentBase64.length * 3) / 4),
          fileStatus: 'pending_scan',
          counts: false,
          attachedBy: ME,
          attachedAt: FAKE_NOW,
        };
        record.evidence.push(item);
        ctx.entry(record, 'evidence_attached', ['category']);
        return Promise.resolve(ok({ version: ctx.commit(record, {}).version, item }));
      },
      detach: (id, evidenceId, version) => {
        const failed = ctx.injected('evidence.detach');
        if (failed) return Promise.resolve(failed);
        const record = ctx.guard(id, version);
        if (isFailure(record)) return Promise.resolve(record);
        record.evidence = record.evidence.filter((item) => item.id !== evidenceId);
        ctx.entry(record, 'evidence_detached', ['removedAt']);
        return Promise.resolve(ok({ version: ctx.commit(record, {}).version }));
      },
      content: (id, evidenceId) => {
        const failed = ctx.injected('evidence.content');
        if (failed) return Promise.resolve(failed);
        const found = ctx.visible(id)?.evidence.find((item) => item.id === evidenceId);
        return Promise.resolve(
          found?.fileStatus === 'clean'
            ? ok({
                displayName: found.displayName,
                contentType: found.contentType,
                contentBase64: 'AAAA',
              })
            : fail(404, 'not_found'),
        );
      },
    },
    vehicles: {
      applyStatus: () => {
        const failed = ctx.injected('vehicles.applyStatus');
        return Promise.resolve(failed ?? ok(null));
      },
    },
  };
}
