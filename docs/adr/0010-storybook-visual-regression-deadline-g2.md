# ADR-0010 — El propietario amplía a G2 el plazo de Storybook y regresión visual

Estado: **Decidido por el propietario en el hilo del proyecto el 2026-10-06.** El propietario eligió la opción «ampliar a G2» tocando una tarjeta de decisión en el hilo del proyecto (2026-10-06 10:33 UTC). Este repositorio no puede verificar esa decisión (la misma limitación que ADR-0008 y ADR-0009, que también recogen decisiones tomadas fuera del repositorio): el registro es una transcripción por la sesión autora, no una firma del propietario ni una aprobación de los auditores.
Fecha de la decisión: 2026-10-06 10:33 UTC.
Decisor: Alei Ruiz (propietario).

## Contexto

ADR-0008 difirió Storybook como runtime y los snapshots de píxeles (regresión visual) «a antes de la primera pantalla funcional y, como máximo, a G1». En la segunda ronda de G1 el auditor B lo señaló como hallazgo Medium M2: ya existen pantallas funcionales (CORE-WEB, #28) y solo hay un snapshot ARIA; SPECS §9.1 exige regresión visual; y la tabla de pendientes del propio repositorio (`docs/tasks/CORE-INTEGRATE-M1-20261006.md`) indicaba que el propietario debía ampliar o eximir el plazo.

## Decisión

El 2026-10-06 a las 10:33 UTC, mediante una tarjeta de decisión en el hilo del proyecto, el propietario decidió **ampliar** el plazo a G2:

- Storybook como runtime y los snapshots de píxeles / regresión visual deben existir, como máximo, **antes de cerrar G2**.
- Esto **supera la fecha límite de ADR-0008** («como máximo G1») solo para este diferimiento; el resto de ADR-0008 no cambia.
- **No es una exención:** SPECS §9.1 sigue exigiendo regresión visual; solo se mueve la fecha.

## Lo que esta decisión no hace

- No exime ni cancela Storybook ni la regresión visual.
- No cambia SPEC-1.4 ni ORCH-1.4, ni los pines de modelo (ADR-0006/0007), ni el proveedor único activo.
- No aprueba G1: G1 conserva sus dos auditores independientes y la aceptación del propietario (ADR-0008).
- No toca `docs/baselines` ni los manifests de integridad, ni edita ADR-0008 (la evidencia histórica no se reescribe).
- No autoriza AWS (ADR-0002 sigue vigente) ni producción.

## Consecuencias y verificación

- No se añade ninguna pantalla funcional nueva más allá del alcance de M1 hasta que Storybook y la regresión visual estén en el repositorio.
- Storybook (runtime) y los snapshots de píxeles deben existir antes de que se cierre G2; hasta entonces, las stories se siguen renderizando y escaneando con axe mediante el renderizador CSF mínimo de `e2e/browser-app/stories.tsx`.
- Si el propietario retira o corrige la decisión, un ADR posterior debe sustituirlo; el repositorio no puede comprobar el hilo del proyecto.
- Los informes de G1 y G2 deben citar este ADR como decisión del propietario transcrita y no verificable desde el repositorio, no como aprobación de los auditores.
