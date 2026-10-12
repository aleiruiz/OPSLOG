import { describe, expect, it } from 'vitest';
import {
  MaintenancePlanError,
  addCalendarDays,
  makePlan,
  opaqueId,
  parsePlanInput,
  patchPlan,
  targets,
  type MaintenancePlan,
} from './index.js';

const baseInput = { vehicleId: 'vehicle-a', intervalDays: 30, lastServiceDate: '2026-01-01' };
const basePlan: MaintenancePlan = {
  ...baseInput,
  tenantId: 'tenant-a',
  id: 'plan-a',
  state: 'active',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('maintenance plan rules', () => {
  it('accepts opaque IDs and rejects unsafe, empty and oversized IDs', () => {
    expect(opaqueId('id_1-A')).toBe('id_1-A');
    for (const value of ['', ' has-space', 'a'.repeat(65), null, 4])
      expect(() => opaqueId(value)).toThrowError(MaintenancePlanError);
  });

  it('requires a plain object, a known field, and at least one interval', () => {
    for (const value of [null, [], 'value', 3])
      expect(() => parsePlanInput(value)).toThrowError(MaintenancePlanError);
    expect(() => parsePlanInput({ ...baseInput, extra: true })).toThrow(/invalid_input/);
    expect(() => parsePlanInput({ vehicleId: 'vehicle-a' })).toThrow(/invalid_input/);
  });

  it('bounds day and kilometre intervals and validates service odometer values', () => {
    for (const intervalDays of [0, -1, 3651, 1.5, '30'])
      expect(() => parsePlanInput({ ...baseInput, intervalDays })).toThrow(/invalid_input/);
    for (const intervalKm of [0, -1, 10_000_000, 2.5])
      expect(() =>
        parsePlanInput({ vehicleId: 'vehicle-a', intervalKm, lastServiceKm: 0 }),
      ).toThrow(/invalid_input/);
    for (const lastServiceKm of [-1, 10_000_000, 1.1, '100'])
      expect(() =>
        parsePlanInput({ vehicleId: 'vehicle-a', intervalKm: 100, lastServiceKm }),
      ).toThrow(/invalid_input/);
    expect(
      parsePlanInput({ vehicleId: 'vehicle-a', intervalKm: 1, lastServiceKm: 0 }).lastServiceKm,
    ).toBe(0);
  });

  it('accepts only real calendar dates and nullable opaque associations', () => {
    for (const lastServiceDate of ['2026-02-30', '2026-2-01', 'not-a-date', null, 20260101])
      expect(() => parsePlanInput({ ...baseInput, lastServiceDate })).toThrow(/invalid_input/);
    expect(
      parsePlanInput({ ...baseInput, defaultWorkshopId: null, defaultMechanicId: 'mechanic-a' }),
    ).toMatchObject({ defaultWorkshopId: null, defaultMechanicId: 'mechanic-a' });
    expect(() => parsePlanInput({ ...baseInput, defaultWorkshopId: 'invalid id' })).toThrow(
      /invalid_input/,
    );
    expect(() => parsePlanInput({ ...baseInput, defaultMechanicId: 2 })).toThrow(/invalid_input/);
  });

  it('requires a service baseline for each configured interval', () => {
    expect(() =>
      makePlan('tenant-a', 'plan-a', { vehicleId: 'vehicle-a', intervalDays: 30 }, new Date()),
    ).toThrow(/invalid_input/);
    expect(() =>
      makePlan('tenant-a', 'plan-a', { vehicleId: 'vehicle-a', intervalKm: 1000 }, new Date()),
    ).toThrow(/invalid_input/);
    expect(
      makePlan('tenant-a', 'plan-a', parsePlanInput(baseInput), new Date('2026-01-01Z')),
    ).toMatchObject({ state: 'active', version: 1, tenantId: 'tenant-a', id: 'plan-a' });
  });

  it('adds UTC calendar days across month and leap-year boundaries', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('computes both targets or null for an unconfigured dimension', () => {
    expect(targets({ ...basePlan, intervalKm: 1000, lastServiceKm: 5000 })).toEqual({
      targetDate: '2026-01-31',
      targetKm: 6000,
    });
    expect(targets(basePlan)).toEqual({ targetDate: '2026-01-31', targetKm: null });
  });

  it('patches only the same vehicle and preserves lifecycle state while incrementing version', () => {
    expect(
      patchPlan(
        { ...basePlan, state: 'paused' },
        { vehicleId: 'vehicle-a', intervalDays: 60, lastServiceDate: '2026-01-01' },
        new Date('2026-01-02Z'),
      ),
    ).toMatchObject({
      state: 'paused',
      version: 2,
      intervalDays: 60,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(() =>
      patchPlan(
        basePlan,
        { vehicleId: 'vehicle-b', intervalDays: 60, lastServiceDate: '2026-01-01' },
        new Date(),
      ),
    ).toThrow(/invalid_input/);
  });
});
