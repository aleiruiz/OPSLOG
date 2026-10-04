# FND-ORCH — runtime inicial

Esta implementación materializa el núcleo sintético de coordinación de M0:

- leases exclusivos con worktree, base SHA, proveedor, modelo, epoch y fencing;
- rechazo de leases duplicados, fencing obsoleto, expiración y cambios de SHA;
- gates acumulativos y dependencias que bloquean etapas posteriores;
- validación de candidato contra el mismo SHA auditado, proveedor activo y CI;
- handoff de proveedor con drenaje obligatorio y aumento de epoch;
- snapshot/restore sin credenciales ni datos externos.

## Trazabilidad requisito → implementación → prueba → evidencia

| Requisito                 | Implementación                                           | Prueba                                             | Evidencia esperada                           |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| Lease exclusivo y fencing | `runtime.ts#acquire`, `renew`, `complete`                | lease duplicado, fencing obsoleto, renovación      | SHA del PR + resultado CI                    |
| Timeout y recuperación    | `acquire` reasigna lease expirado con fencing nuevo      | reasignación después de expiración                 | evento sintético y test unitario             |
| Aislamiento de paths      | `acquire` valida `requestedPaths` contra `allowedPaths`  | path permitido/denegado                            | lease con alcance explícito                  |
| SHA candidato             | `complete` conserva `baseSha` y registra `candidateSha`  | candidato distinto de base y SHA auditado          | candidato CI/auditoría del mismo SHA         |
| Gate acumulativo          | `setGate` exige tareas completas y evidencia válida      | gate sin evidencia bloqueado; gate válido aceptado | `Candidate` con auditoría única, modelo y CI |
| Idempotencia/reinicio     | `eventIds` y `RuntimeSnapshot` conservan fencing/eventos | evento repetido y restore                          | snapshot sintético reproducible              |
| Proveedor activo          | constructor y `handoff` fijan modelo/epoch               | handoff sin leases y modelo observado              | proveedor/modelo del candidato               |

## Alcance actual

El runtime es deliberadamente puro y sintético. GitHub, almacenamiento persistente y
worktrees reales se conectarán en la integración posterior; este paquete no lee `.env`,
no usa AWS y no declara G0 aprobado.

## Validación

```text
pnpm exec prettier --write tools/orchestrator tests/orchestrator
pnpm exec tsc -p tests/orchestrator/tsconfig.json --pretty false
pnpm exec vitest run tests/orchestrator/runtime.test.ts
```

Resultado local: 5 pruebas del runtime, contratos, UI, axe y coverage raíz pasando.
La configuración de cobertura se hereda de la integración ya fusionada en PR4; no se
modifican `package.json` ni el lockfile desde este paquete.
