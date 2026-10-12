import { describe, expect, it } from 'vitest';
import { TypeOrmMechanicStore } from './index.js';

describe('TypeOrmMechanicStore configuration', () => {
  it('rejects non-MySQL data sources and schema synchronization', () => {
    expect(
      () => new TypeOrmMechanicStore({ options: { type: 'sqlite', synchronize: false } } as never),
    ).toThrow(/MySQL/);
    expect(
      () => new TypeOrmMechanicStore({ options: { type: 'mysql', synchronize: true } } as never),
    ).toThrow(/synchronize disabled/);
    expect(
      () => new TypeOrmMechanicStore({ options: { type: 'mysql', synchronize: false } } as never),
    ).not.toThrow();
  });
});
