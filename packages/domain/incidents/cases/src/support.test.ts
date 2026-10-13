import { describe, expect, it } from 'vitest';
import { IncidentError } from './errors.js';
import { validateIncidentEvent } from './events.js';
import { editableFields, vehicleProposal } from './rules.js';
import { incidentView, transitionView } from './views.js';
import { FOLIO_PATTERN } from './folio.js';
import { MANAGER, REPORTER, TENANT_A, VEHICLE, setup } from './test-support.js';
import * as barrel from './index.js';

describe('outbox events', () => {
  it('accepts only the exact allowlisted payloads', () => {
    expect(
      validateIncidentEvent({
        type: 'incident.created',
        payload: { incidentId: 'a', vehicleId: 'b', version: 1 },
      }).payload,
    ).toEqual({ incidentId: 'a', vehicleId: 'b', version: 1 });
    for (const event of [
      { type: 'incident.created', payload: { incidentId: 'a', version: 1 } },
      { type: 'incident.updated', payload: { incidentId: 'a', version: 1, description: 'x' } },
      { type: 'incident.updated', payload: { incidentId: 'a b', version: 1 } },
      { type: 'incident.deleted', payload: {} },
    ])
      expect(() => validateIncidentEvent(event)).toThrow(IncidentError);
  });
});

describe('views', () => {
  it('hides the tenant, proposes a status for an inoperable vehicle and lists editable fields', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, {
      vehicleId: VEHICLE,
      type: 'collision',
      vehicleOperable: false,
    });
    const view = incidentView(incident, MANAGER);
    expect(view).not.toHaveProperty('tenantId');
    expect(view.vehicleProposal).toEqual({
      suggestedStatus: 'out_of_service',
      reason: `Siniestro ${incident.folio}`,
    });
    expect(view.editableFields).toContain('vehicleId');
    expect(incidentView(incident, REPORTER).editableFields).toEqual([]);
    expect(vehicleProposal({ ...incident, status: 'closed' })).toBeNull();
    expect(vehicleProposal({ ...incident, vehicleOperable: true })).toBeNull();
    expect(vehicleProposal({ ...incident, totalLoss: true })).toEqual({
      suggestedStatus: 'decommissioned',
      reason: `Pérdida total, siniestro ${incident.folio}`,
    });
    expect(vehicleProposal({ ...incident, totalLoss: true, status: 'closed' })).toBeNull();
    expect(vehicleProposal({ ...incident, vehicleOperable: true, totalLoss: false })).toBeNull();
    expect(editableFields('repair')).toEqual(['severity', 'description', 'damage', 'location']);
    expect(editableFields('cancelled')).toEqual([]);
    const [entry] = await service.history(TENANT_A, MANAGER, incident.id);
    expect(transitionView(entry!)).not.toHaveProperty('tenantId');
    expect(transitionView(entry!)).not.toHaveProperty('incidentId');
    expect(FOLIO_PATTERN.test(incident.folio)).toBe(true);
    expect(barrel.IncidentService).toBe(barrel.IncidentService);
  });
});
