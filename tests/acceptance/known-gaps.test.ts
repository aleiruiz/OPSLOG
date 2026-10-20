import { afterAll, beforeAll, expect, it } from 'vitest';
import { acceptance, startAcceptance, type AcceptanceWorld } from './support.js';

/**
 * Brechas conocidas, registradas (no son skips): cada caso fija el comportamiento ACTUAL, que no
 * cumple el requisito. Pasa mientras la brecha exista y falla en cuanto el producto la corrija, para
 * que quien la corrija actualice el caso al comportamiento pedido. Cada una es un hallazgo de
 * `docs/traceability/final.md` (FIX pedido al coordinador). Producción no se toca.
 */
acceptance('Brechas conocidas del MVP (registro de hallazgos)', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  beforeAll(async () => {
    w = await startAcceptance();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  // FIX-QA-1 · NFR-S8 y ASVS V2.2.1/V11.1.4: «rate limiting por IP, usuario y API key».
  // El BFF solo traduce el código `rate_limited`; ningún limitador lo emite en el servidor API.
  it('FIX-QA-1 · hoy el inicio de sesión no limita los intentos repetidos: todos responden 401 y ninguno 429', async () => {
    const browser = w.fleet.worldA.browser();
    await w.fleet.worldA.prepare(browser);
    const statuses: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      const reply = await browser.post('/api/auth/login', {
        json: { code: `codigo-invalido-${i}`, nonce: `n-${i}` },
      });
      statuses.push(reply.status);
    }
    // Comportamiento actual (brecha): sin limitador. Al corregir FIX-QA-1 se espera ver un 429.
    expect(statuses).not.toContain(429);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });
});
