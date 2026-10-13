import { isFailure, ok, omit, type FakeContext } from './fakeContext';
import type { IncidentPorts } from './ports';

/** Insurance and resolution writes of the in-memory stand-in: they clear the approvals that depended on them. */
export function createFakeUpdates(
  ctx: FakeContext,
): Pick<IncidentPorts, 'updateInsurance' | 'updateResolution'> {
  return {
    updateInsurance: (id, body) => {
      const failed = ctx.injected('updateInsurance');
      if (failed) return Promise.resolve(failed);
      const record = ctx.guard(id, body.version);
      if (isFailure(record)) return Promise.resolve(record);
      const { policyId, ...fields } = omit(body, 'version');
      ctx.entry(record, 'insurance_updated', Object.keys(fields));
      const policy = policyId
        ? {
            policyId,
            revision: 1,
            insurer: 'Aseguradora Demo',
            policyNumber: 'POL-1',
            coverageType: 'comprehensive',
            startsOn: '2026-01-01',
            endsOn: '2026-12-31',
          }
        : undefined;
      return Promise.resolve(
        ok(
          ctx.commit(record, {
            insurance: {
              ...record.incident.insurance,
              ...fields,
              assumptionApproval:
                null === record.incident.insurance.assumptionApproval
                  ? null
                  : record.incident.insurance.assumptionApproval,
            },
            ...(policy ? { coverage: { status: 'covered', policy, alert: null } } : {}),
          }),
        ),
      );
    },
    updateResolution: (id, body) => {
      const failed = ctx.injected('updateResolution');
      if (failed) return Promise.resolve(failed);
      const record = ctx.guard(id, body.version);
      if (isFailure(record)) return Promise.resolve(record);
      const { costAssumed, ...fields } = omit(body, 'version');
      ctx.entry(
        record,
        'resolution_updated',
        Object.keys(body).filter((key) => key !== 'version'),
      );
      const { incident } = record;
      return Promise.resolve(
        ok(
          ctx.commit(record, {
            resolution: { ...incident.resolution, ...fields, closeApproval: null },
            insurance: {
              ...incident.insurance,
              ...(costAssumed === undefined ? {} : { costAssumed }),
              assumptionApproval: null,
            },
          }),
        ),
      );
    },
  };
}
