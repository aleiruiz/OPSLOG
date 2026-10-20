import { afterAll, beforeAll, expect, it } from 'vitest';
import { acceptance, startAcceptance, type AcceptanceWorld } from './support.js';

/**
 * Brechas conocidas, registradas (no son skips): cada caso describe el comportamiento que el
 * requisito pide y hoy NO se cumple. Se escriben con `it.fails`, que pasa mientras la aserción falla
 * y falla en cuanto el producto lo corrige, para que quien corrija la brecha retire el caso. Cada una
 * es un hallazgo de `docs/traceability/final.md` (FIX pedido al coordinador). Producción no se toca.
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
  it.fails(
    'FIX-QA-1 · el inicio de sesión limita los intentos repetidos desde un mismo origen (429)',
    async () => {
      const browser = w.fleet.worldA.browser();
      await w.fleet.worldA.prepare(browser);
      const statuses: number[] = [];
      for (let i = 0; i < 120; i += 1) {
        const reply = await browser.post('/api/auth/login', {
          json: { code: `codigo-invalido-${i}`, nonce: `n-${i}` },
        });
        statuses.push(reply.status);
      }
      expect(statuses).toContain(429);
    },
  );
});
