import { describe, expect, it } from 'vitest';
import { TypeOrmWorkshopStore } from './index.js';

describe('TypeOrmWorkshopStore configuration', () => {
  it('rejects non-MySQL data sources and schema synchronization', () => {
    expect(
      () => new TypeOrmWorkshopStore({ options: { type: 'sqlite', synchronize: false } } as never),
    ).toThrow(/MySQL/);
    expect(
      () => new TypeOrmWorkshopStore({ options: { type: 'mysql', synchronize: true } } as never),
    ).toThrow(/synchronize disabled/);
    expect(
      () => new TypeOrmWorkshopStore({ options: { type: 'mysql', synchronize: false } } as never),
    ).not.toThrow();
  });
});
