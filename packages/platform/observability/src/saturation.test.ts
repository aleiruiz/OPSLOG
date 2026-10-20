import { describe, expect, it } from 'vitest';
import { isPoolSaturation, UNAVAILABLE_RETRY_AFTER_SECONDS } from './saturation.js';

describe('isPoolSaturation', () => {
  it('recognises the mysql2 queue limit, also wrapped by the driver', () => {
    expect(isPoolSaturation(new Error('Queue limit reached.'))).toBe(true);
    expect(
      isPoolSaturation({
        message: 'query failed',
        driverError: { message: 'Queue limit reached.' },
      }),
    ).toBe(true);
    expect(isPoolSaturation({ message: 'x', cause: new Error('Queue limit reached.') })).toBe(true);
  });

  it('ignores every other failure and bounds the cause chain', () => {
    expect(isPoolSaturation(new Error('ER_ACCESS_DENIED password=hunter2'))).toBe(false);
    expect(isPoolSaturation({ code: 'ECONNRESET' })).toBe(false);
    expect(isPoolSaturation({ code: 'POOL_ENQUEUELIMIT' })).toBe(false);
    expect(isPoolSaturation(new Error('Timeout acquiring connection'))).toBe(false);
    expect(isPoolSaturation(new Error('Queue limit reached. now'))).toBe(false);
    expect(isPoolSaturation(null)).toBe(false);
    expect(isPoolSaturation('Queue limit reached.')).toBe(false);
    const deep = { cause: { cause: { cause: { cause: new Error('Queue limit reached.') } } } };
    expect(isPoolSaturation(deep)).toBe(false);
    expect(UNAVAILABLE_RETRY_AFTER_SECONDS).toBe(2);
  });
});
