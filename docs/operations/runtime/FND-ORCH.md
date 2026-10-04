# FND-ORCH — runtime inicial

Esta implementación materializa el núcleo sintético de coordinación de M0:

- leases exclusivos con worktree, base SHA, proveedor, modelo, epoch y fencing;
- rechazo de leases duplicados, fencing obsoleto, expiración y cambios de SHA;
- gates acumulativos y dependencias que bloquean etapas posteriores;
- validación de candidato contra el mismo SHA auditado, proveedor activo y CI;
- handoff de proveedor con drenaje obligatorio y aumento de epoch;
- snapshot/restore sin credenciales ni datos externos.

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

Resultado local: 4 pruebas pasando. El lint global queda pendiente de que la
configuración raíz incluya el proyecto de `FND-ORCH`; este paquete no puede modificar
esa configuración compartida.
