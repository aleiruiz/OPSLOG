import { describe, expect, it } from 'vitest';
import { describeChange, recordOfEvent } from './diff.js';
import type { ChangeRecord } from './types.js';

const record: ChangeRecord = {
  occurredAt: '2026-10-19T10:00:00.000Z',
  command: 'update',
  fields: [
    { name: 'severity', before: 'low', after: 'high' },
    { name: 'vehicleOperable', before: true, after: false },
    { name: 'vehicleId', before: 'veh-1', after: 'veh-2' },
    { name: 'driverId', before: 'emp-1', after: 'emp-2' },
    { name: 'description' },
    { name: 'location', before: 'Calle Falsa 123', after: 'Otra calle' },
    { name: 'costs' },
    { name: 'mystery', before: 'x', after: 'y' },
    { name: 'policyRevision' },
  ],
};

describe('describeChange', () => {
  it('shows structured values and never the value of ids, free text or unknown fields', () => {
    const changes = describeChange('incident', record, { permissions: ['view'] });
    const by = Object.fromEntries(changes.map((change) => [change.field, change]));
    expect(by['severity']).toMatchObject({ state: 'value', before: 'low', after: 'high' });
    expect(by['vehicleOperable']).toMatchObject({ state: 'value', before: true, after: false });
    expect(by['vehicleId']).toEqual({
      field: 'vehicleId',
      label: 'Vehículo',
      state: 'not_recorded',
    });
    expect(by['driverId']).toEqual({ field: 'driverId', label: 'Conductor', state: 'restricted' });
    expect(by['description']?.state).toBe('restricted');
    expect(by['location']).toEqual({ field: 'location', label: 'Ubicación', state: 'restricted' });
    expect(by['costs']?.state).toBe('restricted');
    expect(by['mystery']).toEqual({ field: 'mystery', label: 'Otro campo', state: 'restricted' });
    expect(by['policyRevision']?.state).toBe('not_recorded');
    expect(JSON.stringify(changes)).not.toMatch(/Calle|emp-|veh-|Otra/);
  });

  it('lifts the personal-data and cost restrictions only with their permission', () => {
    const lifted = describeChange('incident', record, {
      permissions: ['view_pii', 'incidents:view_costs'],
    });
    const by = Object.fromEntries(lifted.map((change) => [change.field, change]));
    expect(by['driverId']).toMatchObject({ state: 'value', before: 'emp-1', after: 'emp-2' });
    expect(by['costs']?.state).toBe('not_recorded');
    expect(by['description']?.state).toBe('restricted');
    expect(by['location']?.state).toBe('restricted');
  });

  it('describes work orders by their status and restricts costs', () => {
    const changes = describeChange(
      'maintenance_work_order',
      {
        occurredAt: record.occurredAt,
        command: 'start',
        fields: [{ name: 'status', before: 'assigned', after: 'in_progress' }, { name: 'costs' }],
      },
      { permissions: [] },
    );
    expect(changes).toEqual([
      {
        field: 'status',
        label: 'Estado',
        state: 'value',
        before: 'assigned',
        after: 'in_progress',
      },
      { field: 'costs', label: 'Costos', state: 'restricted' },
    ]);
    expect(describeChange('vehicle', record, { permissions: [] })[0]?.state).toBe('restricted');
  });
});

describe('recordOfEvent', () => {
  const second: ChangeRecord = { ...record, command: 'coverage_none', fields: [] };
  const other: ChangeRecord = { ...record, occurredAt: '2026-10-19T09:00:00.000Z' };
  it('takes the record at the instant of the event and keeps coverage events apart', () => {
    expect(recordOfEvent('incident.updated', record.occurredAt, [other, second, record])).toBe(
      record,
    );
    expect(recordOfEvent('incident.coverage_none', record.occurredAt, [record, second])).toBe(
      second,
    );
  });
  it('tells created, updated and state-change records of one instant apart', () => {
    const created: ChangeRecord = { ...record, command: 'create', fields: [] };
    const moved: ChangeRecord = { ...record, command: 'transition', fields: [] };
    const all = [created, record, moved];
    expect(recordOfEvent('incident.created', record.occurredAt, all)).toBe(created);
    expect(recordOfEvent('incident.updated', record.occurredAt, all)).toBe(record);
    expect(recordOfEvent('incident.status_changed', record.occurredAt, all)).toBe(moved);
    expect(recordOfEvent('maintenance.work_order.created', record.occurredAt, all)).toBe(created);
  });
  it('finds nothing when no record shares the instant or the kind', () => {
    expect(recordOfEvent('incident.updated', '2026-10-19T08:00:00.000Z', [record])).toBeNull();
    expect(recordOfEvent('incident.coverage_none', record.occurredAt, [record])).toBeNull();
  });
});
