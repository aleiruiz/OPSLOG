import { describe, expect, it } from 'vitest';
import {
  UrlRejected,
  parseDestination,
  resolvePublic,
  systemResolver,
  validateDestination,
  type Resolver,
} from './guard.js';

const publicDns: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const reject = (url: string) => {
  try {
    parseDestination(url);
  } catch (error) {
    return (error as UrlRejected).code;
  }
  return null;
};

describe('destination guard', () => {
  it('accepts a plain public https URL and normalizes the host', () => {
    const parsed = parseDestination('https://Hooks.Example.com./in?x=1');
    expect(parsed.hostname).toBe('hooks.example.com');
    expect(parsed.url.pathname).toBe('/in');
    expect(parseDestination('https://hooks.example.com:443/x').hostname).toBe('hooks.example.com');
  });

  it.each([
    ['http://hooks.example.com/', 'not_https'],
    ['ftp://hooks.example.com/', 'not_https'],
    ['https://user:pw@hooks.example.com/', 'credentials'], // secret-scan:allow synthetic URL with credentials the guard must refuse
    ['https://user@hooks.example.com/', 'credentials'],
    ['https://hooks.example.com:8443/', 'port'],
    ['https://hooks.example.com/#frag', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    [`https://hooks.example.com/${'a'.repeat(2100)}`, 'invalid_url'],
    ['https://localhost/', 'host'],
    ['https://app.localhost/', 'host'],
    ['https://printer.local/', 'host'],
    ['https://db.internal/', 'host'],
    ['https://intranet/', 'host'],
    ['https://127.0.0.1/', 'host'],
    ['https://10.0.0.1/', 'host'],
    ['https://169.254.169.254/latest/meta-data', 'host'],
    ['https://8.8.8.8/', 'host'],
    ['https://[::1]/', 'host'],
    ['https://[::ffff:10.0.0.1]/', 'host'],
    ['https://0x7f.1/', 'host'],
    ['https://2130706433/', 'host'],
  ])('refuses %s', (url, code) => {
    expect(reject(url)).toBe(code);
  });

  it('refuses a non-string without throwing anything else', () => {
    expect(() => parseDestination(undefined as never)).toThrow(UrlRejected);
  });

  it('refuses a name that resolves to a private address, even next to a public one', async () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1'])
      await expect(
        validateDestination('https://a.example.com/', async () => [
          { address: '93.184.216.34', family: 4 },
          { address, family: address.includes(':') ? 6 : 4 },
        ]),
      ).rejects.toMatchObject({ code: 'private_address' });
  });

  it('reports unresolved names without leaking the resolver error', async () => {
    await expect(
      resolvePublic('a.example.com', async () => {
        throw new Error('ENOTFOUND secret-host');
      }),
    ).rejects.toMatchObject({
      code: 'unresolved',
      message: 'webhook destination rejected: unresolved',
    });
    await expect(resolvePublic('a.example.com', async () => [])).rejects.toMatchObject({
      code: 'unresolved',
    });
  });

  it('returns the address to pin the connection to', async () => {
    await expect(resolvePublic('a.example.com', publicDns)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    await expect(validateDestination('https://a.example.com/', publicDns)).resolves.toBeUndefined();
  });

  it('the system resolver answers for a literal localhost name', async () => {
    const found = await systemResolver('localhost');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => entry.family === 4 || entry.family === 6)).toBe(true);
  });
});
