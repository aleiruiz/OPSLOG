# Informe de gate G1 — candidato `a9270686a0c3a531de916b57abd4a9689a29df57`

Fecha: 2026-10-06, America/Mexico_City. Alcance: acumulativo (M0 y M1 hasta el candidato auditado `a9270686`, incluidos los PR #25–#37). Este registro lo redacta la sesión autora de la corrección posterior (#38) y solo transcribe los informes de los auditores y las decisiones del propietario.

## Decisión del propietario (2026-10-06)

- **Plazo de Storybook y regresión visual (M2 del auditor B):** el 2026-10-06 a las 10:33 UTC el propietario decidió ampliar el plazo hasta G2 (ADR-0010). El repositorio no puede verificar esa decisión (se tomó mediante la tarjeta de decisión de la app), igual que ocurre con ADR-0009; este registro la cita por su número y no la prueba.
- **Aceptación de G1:** el 2026-10-06 a las 10:35 UTC Alei Ruiz escribió en el hilo del proyecto: «G1 should be accepted after the doc PR is merged, the actual functionality has been proven to be passed.» **G1 queda ACEPTADO por decisión del propietario**, condicionado a la fusión de este PR de documentación.

## Base de la aceptación: sin re-auditoría del delta (declaración explícita)

Los dos auditores **no volvieron a comprobar el cambio posterior a `a9270686`**. El veredicto del auditor B sobre ese SHA fue REQUEST_CHANGES; el hallazgo M1 se corrigió después en el PR #38 (fusionado como `0d6008e`) y ningún auditor de gate re-auditó `0d6008e`. La cobertura de ese delta es la siguiente y se limita a ella:

- Una única revisión de código Opus (`claude-opus-5-5`, externa al autor) del PR #38 sobre el headSHA `337a9eb`, veredicto APPROVE, conforme a ADR-0007 (una auditoría independiente por PR/headSHA).
- Esa revisión volvió a verificar la comprobación que describió el auditor B (el trabajador vuelve a comprobar el permiso vigente del actor) y ejecutó mutaciones: 22 de 24 mutantes detectados.
- No hubo segunda revisión ni auditoría local adicional del delta, y los dos auditores de gate no lo vieron. La aceptación es por tanto una decisión del propietario sobre una base sin delta re-auditado, no una aprobación de dos auditores sobre el SHA final.

## Resultado

| Auditor                            | Ronda | Modelo observado  | Candidato  | Veredicto       | Informe                         |
| ---------------------------------- | ----- | ----------------- | ---------- | --------------- | ------------------------------- |
| A (independiente, contexto limpio) | 1     | `claude-opus-5-5` | `b53f7af`  | REQUEST_CHANGES | no conservado en el repositorio |
| B (independiente, contexto limpio) | 1     | `claude-opus-5-5` | `b53f7af`  | APPROVE         | no conservado en el repositorio |
| A                                  | 2     | `claude-opus-5-5` | `a9270686` | APPROVE         | [`audit-a.md`](audit-a.md)      |
| B                                  | 2     | `claude-opus-5-5` | `a9270686` | REQUEST_CHANGES | [`audit-b.md`](audit-b.md)      |

## Historial de la ronda

1. `b53f7af`: el auditor A solicitó cambios (revocación de invitaciones y aceptación de invitación en un tenant suspendido); el auditor B aprobó.
2. PR #37 (`a9270686`) corrigió esos hallazgos (más no bloqueantes y escaneo de fugas); revisión de código Opus: APPROVE.
3. `a9270686`, ronda 2: auditor A APPROVE; auditor B REQUEST_CHANGES con dos hallazgos bloqueantes:
   - **M1:** el trabajador ignora los permisos vigentes del actor que encoló el trabajo (criterio de aceptación M1 y fila de la matriz de aislamiento «cambio de permisos con trabajo pendiente»). Corregido en el PR #38 (fusión `0d6008e`); revisión Opus única sobre `337a9eb`: APPROVE; 22/24 mutantes detectados; la comprobación del auditor B fue re-verificada por esa revisión.
   - **M2:** plazo de Storybook y regresión visual de ADR-0008 vencido sin decisión. Resuelto por decisión del propietario el 2026-10-06 10:33 UTC: ampliar a G2 (ADR-0010).
4. 2026-10-06 10:35 UTC: aceptación del propietario (ver arriba).

## Diferimientos y pendientes abiertos

- **AWS (ADR-0002):** diferido; sin viabilidad verificada, producción no autorizada.
- **OIDC real, MFA, límites de tasa:** no implementados en M1.
- **Cola, outbox y auditoría duraderos:** pendientes.
- **Staging real:** pendiente.
- **Storybook como runtime y snapshots de píxeles:** diferidos a G2 (ADR-0010; el repositorio no puede verificar la decisión del propietario).
- **Manifiesto hash de contratos:** acción del propietario, pendiente.
- **`pnpm audit`:** 1 aviso bajo y 3 moderados.
- **Operaciones de operador sin autorización propia.**

## Seguimientos no bloqueantes

- Del PR #38 (revisión Opus):
  - prueba de escaneo de fugas para una segunda coincidencia tras el marcador;
  - prueba de la guarda `startsWith("user-")`;
  - el trabajador solo vuelve a comprobar `kind=user`, de modo que los trabajos de `api_key` la omiten (hoy no existe ninguno);
  - prueba entre tenants del trabajador con la misma identidad.
- Bajos de los auditores:
  - L1: nivel de cobertura 90/85 en `platform/audit`, `worker/base` (resuelto en #38), `outbox`, `infra/storage`, `infra/queues` y `apps/web`;
  - información: clave de cabecera `__proto__` en `apps/api/bff/src/http.ts:89`.

## Registro de decisiones del propietario

- El ruleset de `main` exige pull request desde el 2026-10-06.
- ADR-0009: se descarta FND-ORCH.
- Titular de la LICENSE: pendiente en el PR #39 (abierto).

## Inventario de PR relevantes

| PR      | Contenido                                                            | SHA de fusión |
| ------- | -------------------------------------------------------------------- | ------------- |
| #25–#36 | Slices M1 y CORE-INTEGRATE                                           | n/d           |
| #37     | FIX-G1: revocación de invitaciones, aceptación en tenant suspendido  | `a9270686`    |
| #38     | FIX-G1 ronda 2: el trabajador comprueba el permiso vigente del actor | `0d6008e`     |

Los SHA individuales de #25–#36 no se re-verificaron para este registro. La evidencia por PR (revisión Opus sobre el headSHA vigente) está en las conversaciones de revisión, no en el repositorio.
