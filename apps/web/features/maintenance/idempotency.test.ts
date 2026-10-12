import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_PATTERN } from '@opslog/contracts';
import { SubmitKeys, newSubmitKey, submitTransition } from './idempotency';
import { baseOrder, createFakeMaintenancePorts } from './fakePorts';

const sequence = () => {
  let n = 0;
  return () => `key-${String((n += 1)).padStart(8, '0')}`;
};
const closed = () =>
  baseOrder({ status: 'completed', version: 7, tasks: [{ id: 't1', description: 'x' }] });
const close = { command: 'close', version: 7, vehicleStatus: 'active' } as const;

describe('submit keys', () => {
  it('generates keys the server accepts', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(newSubmitKey())).toBe(true);
    expect(newSubmitKey()).not.toBe(newSubmitKey());
  });

  it('reuses the key for the same request and takes a new one after an edit', () => {
    const keys = new SubmitKeys(sequence());
    const first = keys.keyFor(['wo-1', close]);
    expect(keys.keyFor(['wo-1', { ...close }])).toBe(first);
    expect(keys.keyFor(['wo-1', { ...close, comment: 'editado' }])).not.toBe(first);
  });

  it('keeps the key after a network or server failure and drops it after a definitive answer', () => {
    const keys = new SubmitKeys(sequence());
    const first = keys.keyFor('a');
    keys.settle({ ok: false, error: { status: 500, code: 'network_error' } as never });
    expect(keys.keyFor('a')).toBe(first);
    keys.settle({ ok: false, error: { status: 422, code: 'missing_requirements' } as never });
    expect(keys.keyFor('a')).not.toBe(first);
    const second = keys.keyFor('a');
    keys.settle({ ok: true, value: null });
    expect(keys.keyFor('a')).not.toBe(second);
  });
});

describe('submitTransition', () => {
  it('retries a lost response with the same key and the order closes once', async () => {
    const fake = createFakeMaintenancePorts({ orders: [closed()], viewCosts: true });
    fake.state.lostResponses = 1;
    const result = await submitTransition(fake.ports, new SubmitKeys(sequence()), 'wo-1', close);
    expect(result.ok && result.value.status).toBe('closed');
    expect(fake.state.keys).toHaveLength(2);
    expect(new Set(fake.state.keys).size).toBe(1);
    expect(fake.state.calls).toEqual(['transition:close']);
  });

  it('sends a new key for a new submit after editing', async () => {
    const fake = createFakeMaintenancePorts({ orders: [closed()], viewCosts: true });
    const keys = new SubmitKeys(sequence());
    const rejected = await submitTransition(fake.ports, keys, 'wo-1', {
      command: 'close',
      version: 7,
    });
    expect(rejected.ok).toBe(false);
    await submitTransition(fake.ports, keys, 'wo-1', close);
    expect(fake.state.keys).toHaveLength(2);
    expect(new Set(fake.state.keys).size).toBe(2);
  });
});
