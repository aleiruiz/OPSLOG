import { afterEach, describe, it } from 'vitest';
import {
  namesVersionsAndLimit,
  permissionsAndRevalidation,
  tenantIsolation,
  viewsCompany,
} from './saved-views-scenarios.js';
import { createWorld, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

describe('Platform saved views (in memory)', () => {
  it('isolates companies', async () => {
    world = createWorld();
    await tenantIsolation(
      world,
      await viewsCompany(world, 'Empresa Alfa', 'a'),
      await viewsCompany(world, 'Empresa Beta', 'b'),
    );
  });

  it('shows each reader only what their grants allow and tells them what was left out', async () => {
    world = createWorld();
    await permissionsAndRevalidation(world, await viewsCompany(world, 'Empresa Alfa', 'a'));
  });

  it('keeps names unique, guards versions and limits views to 50 per user and list', async () => {
    world = createWorld();
    await namesVersionsAndLimit(world, await viewsCompany(world, 'Empresa Alfa', 'a'));
  });
});
