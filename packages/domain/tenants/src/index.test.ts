import { describe, expect, it } from 'vitest';
import { opaqueId, opaqueTenantId, uuidV7 } from './index.js';

describe('application-generated identifiers', () => {
  it('generates RFC 9562 UUIDv7 values with the timestamp in the leading bits', () => {
    const timestamp = 1_798_697_600_123;
    const id = uuidV7(timestamp);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp);
  });

  it('uses UUIDv7 for tenant and opaque entity identifiers', () => {
    expect(opaqueTenantId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(opaqueId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
