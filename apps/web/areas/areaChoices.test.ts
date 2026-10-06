import { describe, expect, it } from 'vitest';
import { areaChoices, hasAssignableArea } from './areaChoices';
import { demoAreas } from './fixtures';

describe('area choices', () => {
  const labels = (keep?: string) =>
    areaChoices(demoAreas(), keep ?? null).map((choice) => choice.label.replace(/ /g, '·'));

  it('lists the whole tree in order, indenting by level with non-breaking spaces', () => {
    const all = labels();
    expect(all.slice(0, 5)).toEqual([
      'Centro',
      '··Ciudad de México',
      '····Base Cuautitlán',
      '··Querétaro',
      'Norte',
    ]);
    expect(all).toContain('······Taller');
    expect(areaChoices(demoAreas())[0]?.label.startsWith('Centro')).toBe(true);
  });

  it('marks inactive areas and disables them, except the one a record already has', () => {
    const inactive = areaChoices(demoAreas()).find((choice) => choice.id === 'area-mty-guadalupe');
    expect(inactive).toMatchObject({ disabled: true });
    expect(inactive?.label).toMatch(/\(inactiva\)$/);
    const kept = areaChoices(demoAreas(), 'area-mty-guadalupe').find(
      (choice) => choice.id === 'area-mty-guadalupe',
    );
    expect(kept?.disabled).toBe(false);
    expect(areaChoices(demoAreas()).find((choice) => choice.id === 'area-norte')?.disabled).toBe(
      false,
    );
  });

  it('knows whether anything can be assigned at all', () => {
    expect(hasAssignableArea(areaChoices(demoAreas()))).toBe(true);
    expect(hasAssignableArea([])).toBe(false);
    expect(
      hasAssignableArea(areaChoices(demoAreas().map((area) => ({ ...area, active: false })))),
    ).toBe(false);
  });
});
