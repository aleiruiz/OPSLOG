import { describe, expect, it } from 'vitest';
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  generateSecret,
  signatureHeader,
  signatureOf,
  verifyWebhook,
} from './signature.js';

const SECRET = generateSecret();
const BODY = Buffer.from('{"id":"evt_1","type":"vehicle.created"}');
const NOW = 1_800_000_000_000;
const headers = (secrets: string[], timestamp = String(NOW / 1000), body: Buffer = BODY) => ({
  [EVENT_ID_HEADER]: 'evt_1',
  [TIMESTAMP_HEADER]: timestamp,
  [SIGNATURE_HEADER]: signatureHeader(secrets, timestamp, 'evt_1', body),
});

describe('webhook signature', () => {
  it('generates 32 random bytes with a recognizable prefix', () => {
    expect(SECRET).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(SECRET);
  });

  it('verifies over the exact bytes and refuses a body altered by one byte', () => {
    const ok = verifyWebhook({
      secrets: [SECRET],
      headers: headers([SECRET]),
      body: BODY,
      nowMs: NOW,
    });
    expect(ok).toEqual({ ok: true, eventId: 'evt_1' });
    const altered = Buffer.from(BODY);
    altered[10] = (altered[10] as number) ^ 1;
    expect(
      verifyWebhook({ secrets: [SECRET], headers: headers([SECRET]), body: altered, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('binds the event id and the timestamp into the signature', () => {
    const base = signatureOf(SECRET, '1', 'a', BODY);
    expect(signatureOf(SECRET, '2', 'a', BODY)).not.toBe(base);
    expect(signatureOf(SECRET, '1', 'b', BODY)).not.toBe(base);
    expect(signatureOf(generateSecret(), '1', 'a', BODY)).not.toBe(base);
    expect(signatureOf(SECRET, '1', 'a', BODY.toString())).toBe(base);
  });

  it('rejects a timestamp from six minutes ago and accepts one from four', () => {
    const six = String(NOW / 1000 - 6 * 60);
    expect(
      verifyWebhook({ secrets: [SECRET], headers: headers([SECRET], six), body: BODY, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
    const four = String(NOW / 1000 - 4 * 60);
    expect(
      verifyWebhook({ secrets: [SECRET], headers: headers([SECRET], four), body: BODY, nowMs: NOW })
        .ok,
    ).toBe(true);
    const future = String(NOW / 1000 + 6 * 60);
    expect(
      verifyWebhook({
        secrets: [SECRET],
        headers: headers([SECRET], future),
        body: BODY,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts either secret of a double signature and refuses an unknown one', () => {
    const next = generateSecret();
    const double = headers([next, SECRET]);
    for (const secrets of [[next], [SECRET], [next, SECRET]])
      expect(verifyWebhook({ secrets, headers: double, body: BODY, nowMs: NOW }).ok).toBe(true);
    expect(double[SIGNATURE_HEADER].split(',')).toHaveLength(2);
    expect(
      verifyWebhook({ secrets: [generateSecret()], headers: double, body: BODY, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('deduplicates by event id and validates the headers', () => {
    const seen = new Set<string>();
    const input = {
      secrets: [SECRET],
      headers: headers([SECRET]),
      body: BODY,
      nowMs: NOW,
      seen: (id: string) => (seen.has(id) ? true : (seen.add(id), false)),
    };
    expect(verifyWebhook(input).ok).toBe(true);
    expect(verifyWebhook(input)).toEqual({ ok: false, reason: 'replayed' });
    expect(verifyWebhook({ ...input, headers: {} })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(
      verifyWebhook({ ...input, headers: { ...headers([SECRET]), [TIMESTAMP_HEADER]: 'abc' } }),
    ).toEqual({ ok: false, reason: 'bad_timestamp' });
    // Header names are case-insensitive; a malformed or foreign-version signature never matches.
    const lowered = Object.fromEntries(
      Object.entries(headers([SECRET])).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(verifyWebhook({ secrets: [SECRET], headers: lowered, body: BODY, nowMs: NOW }).ok).toBe(
      true,
    );
    expect(
      verifyWebhook({
        secrets: [SECRET],
        headers: { ...lowered, 'opslog-signature': 'v2=00,v1=zz,v1=00' },
        body: BODY,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
