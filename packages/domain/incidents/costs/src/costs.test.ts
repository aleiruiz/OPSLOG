import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident } from '../../cases/src/index.js';
import { COST_LIMITS } from './catalog.js';
import { parseCostsUpdate } from './input.js';
import { sumByCurrency, summarize } from './summary.js';
import {
  ADMIN,
  TENANT_A,
  TENANT_B,
  VIEWER,
  actorOf,
  caseIn,
  line,
  setup,
  type World,
} from './test-support.js';

const fail = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};
let n = 0;
const key = () => `key-costs-${String((n += 1)).padStart(8, '0')}`;
const put = (
  world: World,
  incident: Pick<Incident, 'id' | 'version'>,
  body: Record<string, unknown>,
  actor = ADMIN,
  k: string | undefined = key(),
) =>
  world.costService.update(TENANT_A, actor, incident.id, { version: incident.version, ...body }, k);

describe('the totals of a case by currency (BR-027, case 3)', () => {
  it('computes repairs + expenses - recoveries exactly, per currency, with no float', () => {
    const lines = [
      line('expense', 'deductible', '200000'),
      line('expense', 'towing', '50000'),
      line('recovery', 'insurer', '800000'),
      line('expense', 'fine', '12345', 'USD'),
    ].map((value, index) => ({ ...value, id: `l${index}`, note: null })) as never;
    expect(summarize(lines, [{ amountMinor: '1000000', currency: 'MXN' }])).toEqual([
      {
        currency: 'MXN',
        repairs: '1000000',
        expenses: '250000',
        recoveries: '800000',
        companyBorne: '450000',
      },
      { currency: 'USD', repairs: '0', expenses: '12345', recoveries: '0', companyBorne: '12345' },
    ]);
    // A recovery above the costs is a negative amount, still exact.
    expect(
      summarize(
        [
          {
            id: 'a',
            kind: 'recovery',
            category: 'insurer',
            amount: { amountMinor: '5', currency: 'EUR' },
            note: null,
          },
        ],
        [],
      ),
    ).toMatchObject([{ currency: 'EUR', companyBorne: '-5' }]);
    expect(summarize([], [])).toEqual([]);
    const big = '999999999999999';
    expect(
      sumByCurrency([big, big, big].map((amountMinor) => ({ amountMinor, currency: 'MXN' }))),
    ).toEqual([{ currency: 'MXN', amountMinor: '2999999999999997' }]);
    expect(
      sumByCurrency([
        { amountMinor: '1', currency: 'USD' },
        { amountMinor: '1', currency: 'MXN' },
        { amountMinor: '1', currency: 'USD' },
      ]),
    ).toEqual([
      { currency: 'MXN', amountMinor: '1' },
      { currency: 'USD', amountMinor: '2' },
    ]);
  });
});

describe('input of PUT costs', () => {
  const known = new Set(['known']);
  const rejects = (input: unknown, field?: string) => {
    try {
      parseCostsUpdate(input, known);
    } catch (error) {
      const e = error as IncidentError;
      expect(e.code).toBe('invalid_input');
      if (field) expect(e.fieldErrors.map((f) => f.field)).toContain(field);
      return;
    }
    throw new Error('expected a rejection');
  };
  it('accepts a full body and keeps only the ids of existing lines', () => {
    const parsed = parseCostsUpdate(
      {
        version: 3,
        lines: [
          { id: 'known', ...line('recovery', 'third_party', '10', 'USD', { note: ' nota ' }) },
        ],
        initialEstimate: { amountMinor: '99', currency: 'MXN' },
      },
      known,
    );
    expect(parsed).toMatchObject({
      version: 3,
      lines: [{ id: 'known', note: 'nota', kind: 'recovery' }],
      initialEstimate: { amountMinor: '99', currency: 'MXN' },
    });
    expect(
      parseCostsUpdate({ version: 1, lines: [], initialEstimate: null }, known).initialEstimate,
    ).toBeNull();
    expect(parseCostsUpdate({ version: 1, lines: [] }, known).initialEstimate).toBeUndefined();
  });
  it('names every bad field and never the value', () => {
    rejects({}, 'version');
    rejects({ version: 1 }, 'lines');
    rejects({ version: 1, lines: 'x' }, 'lines');
    rejects({ version: 1, lines: [], extra: 1 });
    rejects({ version: 1, lines: ['x'] }, 'lines[0]');
    rejects({ version: 1, lines: [line('expense', 'insurer', '1')] }, 'lines[0].category');
    rejects({ version: 1, lines: [line('recovery', 'towing', '1')] }, 'lines[0].category');
    rejects({ version: 1, lines: [line('driver' as never, 'x', '1')] }, 'lines[0].kind');
    rejects({ version: 1, lines: [{ ...line('expense', 'towing', '1'), extra: 1 }] }, 'lines[0]');
    for (const amountMinor of ['0', '01', '-5', '1.5', '1e3', '1234567890123456', '', 5 as never])
      rejects({ version: 1, lines: [line('expense', 'towing', amountMinor)] }, 'lines[0].amount');
    for (const currency of ['mx', 'MXNN', '', 5 as never])
      rejects({ version: 1, lines: [line('expense', 'towing', '1', currency)] }, 'lines[0].amount');
    rejects(
      {
        version: 1,
        lines: [
          {
            ...line('expense', 'towing', '1'),
            amount: { amountMinor: '1', currency: 'MXN', x: 1 },
          },
        ],
      },
      'lines[0].amount',
    );
    rejects(
      { version: 1, lines: [{ ...line('expense', 'towing', '1'), amount: 5 }] },
      'lines[0].amount',
    );
    rejects(
      { version: 1, lines: [{ ...line('expense', 'towing', '1'), note: 'x'.repeat(201) }] },
      'lines[0].note',
    );
    rejects(
      { version: 1, lines: [{ ...line('expense', 'towing', '1'), id: 'unknown' }] },
      'lines[0].id',
    );
    rejects(
      { version: 1, lines: [{ ...line('expense', 'towing', '1'), id: '../x' }] },
      'lines[0].id',
    );
    rejects(
      {
        version: 1,
        lines: [
          { id: 'known', ...line('expense', 'towing', '1') },
          { id: 'known', ...line('expense', 'towing', '2') },
        ],
      },
      'lines',
    );
    rejects({ version: 1, lines: [], initialEstimate: 5 }, 'initialEstimate');
    rejects(
      { version: 1, lines: [], initialEstimate: { amountMinor: '0', currency: 'MXN' } },
      'initialEstimate',
    );
    rejects(
      {
        version: 1,
        lines: Array.from({ length: COST_LIMITS.lines + 1 }, () => line('expense', 'other', '1')),
      },
      'lines',
    );
    expect(
      parseCostsUpdate(
        {
          version: 1,
          lines: Array.from({ length: COST_LIMITS.lines }, () => line('expense', 'other', '1')),
        },
        known,
      ).lines,
    ).toHaveLength(50);
  });
});

describe('PUT costs (FR-117, case 10)', () => {
  it('replaces lines and estimate, bumps the version and keeps amounts out of timeline, audit and events', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review', {
      closeApproval: { by: 'user-x', at: '2026-10-13T17:00:00.000Z' },
    });
    const result = await put(world, incident, {
      lines: [line('expense', 'towing', '50000', 'MXN', { note: 'Grúa sintética' })],
      initialEstimate: { amountMinor: '999', currency: 'USD' },
    });
    expect(result.incident.version).toBe(incident.version + 1);
    expect(result.incident.closeApproval).toBeNull();
    expect(result.costs).toMatchObject({
      version: incident.version + 1,
      initialEstimate: { amountMinor: '999', currency: 'USD' },
      mixedCurrencies: false,
      totals: [{ currency: 'MXN', expenses: '50000', companyBorne: '50000' }],
      differsFromLastClosure: false,
      snapshots: [],
    });
    // The estimate is informative: it is in no total.
    expect(result.costs.totals.map((t) => t.currency)).toEqual(['MXN']);
    const entry = (await world.store.history(TENANT_A, incident.id)).at(-1);
    expect(entry).toMatchObject({
      command: 'costs_changed',
      changedFields: ['closeApproval', 'costLines', 'initialEstimate'],
      before: { lineCount: 0, hadEstimate: false },
    });
    const events = world.store.events.filter((e) => e.event.type === 'incident.costs_changed');
    expect(events.map((e) => e.event.payload)).toEqual([
      { incidentId: incident.id, version: result.incident.version },
    ]);
    expect(world.store.audit.at(-1)?.action).toBe('incident.costs_changed');
    const leaked = JSON.stringify([entry, events, world.store.audit]);
    for (const secret of ['50000', 'MXN', 'USD', '999', 'Grúa sintética'])
      expect(leaked).not.toContain(secret);
  });

  it('keeps the ids of the lines it is given back, drops the rest and clears the estimate on null', async () => {
    const world = setup();
    const incident = await caseIn(world, 'repair');
    const first = await put(world, incident, {
      lines: [line('expense', 'other', '1'), line('recovery', 'insurer', '2')],
      initialEstimate: { amountMinor: '5', currency: 'MXN' },
    });
    const [a] = first.costs.lines;
    const second = await put(world, first.incident, {
      lines: [{ id: a?.id, ...line('expense', 'other', '7') }],
      initialEstimate: null,
    });
    expect(second.costs.lines).toEqual([
      {
        id: a?.id,
        kind: 'expense',
        category: 'other',
        amount: { amountMinor: '7', currency: 'MXN' },
        note: null,
      },
    ]);
    expect(second.costs.initialEstimate).toBeNull();
    expect((await world.store.history(TENANT_A, incident.id)).at(-1)?.before).toEqual({
      lineCount: 2,
      hadEstimate: true,
    });
  });

  it('is a no-op when nothing changes: no version, no timeline entry, no event', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    const first = await put(world, incident, { lines: [line('expense', 'other', '1')] });
    const [a] = first.costs.lines;
    const same = await put(world, first.incident, {
      lines: [{ id: a?.id, ...line('expense', 'other', '1') }],
    });
    expect(same.incident.version).toBe(first.incident.version);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.costs_changed'),
    ).toHaveLength(1);
  });

  it('is allowed in every non-terminal state but draft', async () => {
    const world = setup();
    for (const status of [
      'reported',
      'under_review',
      'insurance_process',
      'insurance_rejected',
      'no_insurance',
      'repair',
      'resolved',
      'reopened',
    ] as const) {
      const incident = await caseIn(world, status);
      expect(
        (await put(world, incident, { lines: [line('expense', 'other', '1')] })).incident.version,
      ).toBe(incident.version + 1);
    }
    for (const status of ['draft', 'closed', 'cancelled'] as const) {
      const incident = await caseIn(world, status);
      expect((await fail(put(world, incident, { lines: [] }))).code).toBe('invalid_transition');
    }
    const incident = await caseIn(world, 'under_review');
    expect(
      (
        await fail(
          world.costService.update(TENANT_A, ADMIN, incident.id, { version: 99, lines: [] }, key()),
        )
      ).code,
    ).toBe('stale_version');
  });

  it('needs incidents:edit and incidents:view_costs, and the key (case 4 and 10)', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    const noCosts = actorOf('00000000-0000-4000-8000-0000000000c1', [
      'incidents:view',
      'incidents:edit',
    ]);
    const noEdit = actorOf('00000000-0000-4000-8000-0000000000c2', [
      'incidents:view',
      'incidents:view_costs',
    ]);
    const generic = actorOf('00000000-0000-4000-8000-0000000000c3', [
      'view',
      'edit',
      'view_costs',
      'incidents:view',
    ]);
    for (const actor of [noCosts, noEdit, generic, VIEWER])
      expect((await fail(put(world, incident, { lines: [] }, actor))).code).toBe('forbidden');
    expect((await fail(world.costService.get(TENANT_A, noCosts, incident.id))).code).toBe(
      'forbidden',
    );
    expect((await world.costService.get(TENANT_A, noEdit, incident.id)).costs.lines).toEqual([]);
    expect((await fail(world.costService.get(TENANT_B, ADMIN, incident.id))).code).toBe(
      'not_found',
    );
    expect(
      (
        await fail(
          world.costService.update(TENANT_A, ADMIN, incident.id, {
            version: incident.version,
            lines: [],
          }),
        )
      ).code,
    ).toBe('idempotency_key_required');
    expect((await fail(put(world, incident, { lines: [] }, ADMIN, 'x'))).code).toBe(
      'invalid_input',
    );
    expect(await world.costs.lines(TENANT_A, incident.id)).toEqual([]);
  });

  it('replays the same key and body, refuses another body, and concurrent twins make one change', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    const body = { lines: [line('expense', 'other', '1')] };
    const k = key();
    const first = await put(world, incident, body, ADMIN, k);
    const replay = await put(world, incident, body, ADMIN, k);
    expect(replay.incident.version).toBe(first.incident.version);
    expect(replay.costs.lines).toEqual(first.costs.lines);
    expect((await fail(put(world, incident, { lines: [] }, ADMIN, k))).code).toBe(
      'idempotency_conflict',
    );
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.costs_changed'),
    ).toHaveLength(1);

    const other = await caseIn(world, 'under_review');
    const twinKey = key();
    const [one, two] = await Promise.all([
      put(world, other, body, ADMIN, twinKey),
      put(world, other, body, ADMIN, twinKey),
    ]);
    expect(one.incident.version).toBe(two.incident.version);
    expect(await world.costs.lines(TENANT_A, other.id)).toHaveLength(1);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.costs_changed'),
    ).toHaveLength(2);
  });

  it('recognises a retry even when the lines it names changed since it first ran', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    const first = await put(world, incident, { lines: [line('expense', 'other', '1')] });
    const [a] = first.costs.lines;
    const body = { lines: [{ id: a?.id, ...line('expense', 'other', '2') }] };
    const k = key();
    const edited = await put(world, first.incident, body, ADMIN, k);
    // Another edit drops that line; the lost-answer retry replays instead of failing on the old id.
    const dropped = await put(world, edited.incident, { lines: [] });
    expect(dropped.costs.lines).toEqual([]);
    const retry = await put(world, first.incident, body, ADMIN, k);
    expect(retry.incident.version).toBe(edited.incident.version);
    // A first attempt naming an unknown line still fails on the id.
    const unknown = { lines: [{ id: 'gone', ...line('expense', 'other', '2') }] };
    expect((await fail(put(world, dropped.incident, unknown))).code).toBe('invalid_input');
  });

  it('two different edits from the same version: the second is stale', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    const results = await Promise.allSettled([
      put(world, incident, { lines: [line('expense', 'other', '1')] }),
      put(world, incident, { lines: [line('expense', 'other', '2')] }),
    ]);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as IncidentError).code).toBe('stale_version');
    expect(await world.costs.lines(TENANT_A, incident.id)).toHaveLength(1);
  });
});

describe('GET costs (case 1, 2 and 3)', () => {
  it('counts a linked order once, beside own lines, per currency and never mixed', async () => {
    const world = setup();
    world.orders.add('o1', { costs: [{ amountMinor: '1000000', currency: 'MXN' }] });
    world.orders.add('o2', { costs: [{ amountMinor: '999', currency: 'MXN' }] });
    const incident = await caseIn(world, 'repair');
    const one = await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId: 'o1' },
      'key-link-0000001',
    );
    const two = await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: one.incident.version, orderId: 'o2' },
      'key-link-0000002',
    );
    // Cancelled after being linked: it stays linked but adds nothing.
    world.orders.add('o2', {
      costs: [{ amountMinor: '999', currency: 'MXN' }],
      status: 'cancelled',
    });
    const saved = await put(world, two.incident, {
      lines: [
        line('expense', 'deductible', '200000'),
        line('expense', 'towing', '50000'),
        line('recovery', 'insurer', '800000'),
        line('expense', 'fine', '1200', 'USD'),
      ],
    });
    expect(saved.costs.totals).toEqual([
      {
        currency: 'MXN',
        repairs: '1000000',
        expenses: '250000',
        recoveries: '800000',
        companyBorne: '450000',
      },
      { currency: 'USD', repairs: '0', expenses: '1200', recoveries: '0', companyBorne: '1200' },
    ]);
    expect(saved.costs.mixedCurrencies).toBe(true);
    expect(saved.costs.repairs).toEqual([
      { linkId: one.link.id, orderId: 'o1', totals: [{ currency: 'MXN', amountMinor: '1000000' }] },
      { linkId: two.link.id, orderId: 'o2', totals: [] },
    ]);
    // Reading again, nothing is copied: a change of the order is a change of the total.
    world.orders.add('o1', { costs: [{ amountMinor: '1500000', currency: 'MXN' }] });
    expect(
      (await world.costService.get(TENANT_A, ADMIN, incident.id)).costs.totals[0]?.companyBorne,
    ).toBe('950000');
  });

  it('shows the policy deductible as insurance keeps it, never converted', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review', {
      coverageStatus: 'covered',
      policySnapshot: {
        policyId: 'p',
        revision: 2,
        insurer: 'A',
        policyNumber: 'N',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      },
    });
    world.deductibles.value = { kind: 'percent', basisPoints: 500 };
    expect(
      (await world.costService.get(TENANT_A, ADMIN, incident.id)).costs.policyDeductible,
    ).toEqual({ kind: 'percent', basisPoints: 500 });
    world.deductibles.fail = true;
    await expect(world.costService.get(TENANT_A, ADMIN, incident.id)).rejects.toThrow(
      'policy unavailable',
    );
    const bare = await caseIn(world, 'under_review');
    expect(
      (await world.costService.get(TENANT_A, ADMIN, bare.id)).costs.policyDeductible,
    ).toBeNull();
  });

  it('fails (500) when a linked order cannot be read, never a zero', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId: 'o1' },
      'key-link-0000001',
    );
    world.orders.fail = true;
    await expect(world.costService.get(TENANT_A, ADMIN, incident.id)).rejects.toThrow(
      'orders unavailable',
    );
    await expect(world.ledger.totals(TENANT_A, incident.id)).rejects.toThrow('orders unavailable');
  });
});
