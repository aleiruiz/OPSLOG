import type { Platform } from '../../../apps/api/composition/src/index.js';
import { plateOf, syntheticProjections } from '../search/generate.js';

export interface SeedSize {
  /** Vehicles created through the vehicle API (SPECS §9.3: 500 per company). */
  readonly vehicles: number;
  /** Employees created through the employee API, personal data sealed (SPECS §9.3: 1000). */
  readonly employees: number;
  /** Entities written straight into the search projection with the search benchmark's generator. */
  readonly searchEntities: number;
}

export interface SeedResult {
  readonly areaId: string;
  readonly vehicleIds: readonly string[];
  readonly platePrefixes: readonly string[];
  readonly plateInfixes: readonly string[];
  readonly tenantId: string;
}

const CONCURRENCY = 8;
const SEARCH_BATCH = 1_000;
let sequence = 0;
/** Names are letters only in the employee rules: the index written in base 26. */
function letters(index: number): string {
  let rest = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return out;
}

const corr = (): string => `load-seed-${(sequence += 1)}`;

/** Runs `count` tasks with a small fixed concurrency; the first failure stops the run. */
async function inParallel(count: number, task: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
}

function ensure<T>(
  result: { ok: boolean; value?: T | undefined; error?: { code: string } },
  what: string,
): T {
  if (!result.ok || result.value === undefined)
    throw new Error(`seed ${what} failed: ${result.error?.code}`);
  return result.value;
}

/**
 * Fills one company through the platform APIs (so the data is what the application would hold:
 * sealed personal data, blind indexes, audit, outbox) and then indexes it. The search projection is
 * topped up with the benchmark's synthetic entities up to `searchEntities`.
 */
export async function seedCompany(
  platform: Platform,
  token: string,
  tenantId: string,
  size: SeedSize,
): Promise<SeedResult> {
  const area = ensure(
    await platform.areas.create(token, corr(), {
      name: 'Flota de carga',
      code: null,
      parentId: null,
      responsibleIds: [],
    }),
    'area',
  ) as { id: string };
  const vehicleIds: string[] = new Array<string>(size.vehicles).fill('');
  await inParallel(size.vehicles, async (i) => {
    const created = ensure(
      await platform.vehicles.create(token, corr(), {
        economicNumber: `SEED-${String(i).padStart(5, '0')}`,
        plate: `SD${String(i).padStart(5, '0')}`,
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: area.id,
        odometerKm: 1000 + i,
      }),
      'vehicle',
    ) as { id: string };
    vehicleIds[i] = created.id;
  });
  await inParallel(size.employees, async (i) => {
    const driver = i % 10 < 7;
    ensure(
      await platform.employees.create(token, corr(), {
        kind: driver ? 'driver' : 'dispatcher',
        firstName: `Nombre ${letters(i)}`,
        lastName: `Apellido ${letters(i)}`,
        areaId: area.id,
        employeeNumber: `SEED-E${String(i).padStart(5, '0')}`,
        idType: 'ine',
        nationalId: `SYNTH-ID-${String(i).padStart(6, '0')}`,
        phone: `+5255${String(10_000_000 + i)}`,
        email: `seed${i}@synthetic.example`,
        ...(driver
          ? {
              licenseNumber: `LIC-${String(i).padStart(6, '0')}`,
              licenseType: 'c',
              licenseExpiresOn: '2099-12-31',
            }
          : {}),
      }),
      'employee',
    );
  });
  // The real records first, through the indexer the worker uses; then the synthetic bulk.
  await platform.search.indexer.rebuild(tenantId);
  let batch = [];
  for (const projection of syntheticProjections(tenantId, size.searchEntities)) {
    batch.push(projection);
    if (batch.length === SEARCH_BATCH) {
      await platform.search.store.apply(tenantId, { upserts: batch, removals: [] });
      batch = [];
    }
  }
  if (batch.length > 0)
    await platform.search.store.apply(tenantId, { upserts: batch, removals: [] });
  // Terms that exist: plates of the synthetic bulk, spread across the dataset.
  const spread = (n: number) => Array.from({ length: 25 }, (_, i) => (i * 7919) % Math.max(n, 1));
  return {
    areaId: area.id,
    vehicleIds: vehicleIds.slice(0, 200),
    platePrefixes: spread(size.searchEntities).map((i) => plateOf(i).slice(0, 6)),
    plateInfixes: spread(size.searchEntities).map((i) => plateOf(i).slice(2, 7)),
    tenantId,
  };
}
