# DOCS-INSURANCE-WEB-M2-20261006 — pantallas de Documentos y Seguros (lista, ficha, alta, edición, renovación, archivado e historial)

```yaml
id: DOCS-INSURANCE-WEB-M2-20261006
baseline:
  [
    SPEC-1.4,
    ORCH-1.4,
    inherited: SPEC-1.0/ORCH-1.0,
    SPEC-1.1/ORCH-1.1,
    SPEC-1.2/ORCH-1.2,
    SPEC-1.3/ORCH-1.3,
  ]
milestone: M2
kind: implementation
slice: web
baseSHA: 4d02024b238c39dc6f91db7743ee29eb803c0964
depends_on: [DOCS-M2-20261006, INSURANCE-M2-20261006, VEHICLES-WEB-M2-20261006, CORE-WEB, ADR-0010]
write_paths:
  [
    apps/web/documents/**,
    apps/web/insurance/**,
    apps/web/app/**,
    apps/web/api/**,
    apps/web/tsconfig.json,
    apps/web/vitest.config.ts,
    packages/ui/.storybook/main.ts,
    e2e/**,
    docs/tasks/DOCS-INSURANCE-WEB-M2-20261006.md,
    package.json,
  ]
```

Pantallas de Documentos (`/api/documents`) y Seguros (`/api/insurance-policies`) sobre los backends ya fusionados (`DOCS-M2-20261006`, `INSURANCE-M2-20261006`), con el mismo patrón que Vehículos y Áreas. Solo datos sintéticos; sin AWS ni OIDC real; sin cambios de backend ni de `@opslog/ui`. ADR-0010: todas las pantallas tienen stories con baselines de píxeles en 1280 y 360.

## Alcance entregado

| Pantalla   | Ruta                                  | Permiso  | Estados cubiertos                                                                                                                                                                                                  |
| ---------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lista      | `/flota/documentos`, `/flota/seguros` | `view`   | carga, vacío, sin resultados, error con reintento, 403, 401, «cargar más» (en curso y fallido), filtros (estado, propietario o vehículo, tipo, vigente en una fecha, archivados), vehículos no disponibles         |
| Ficha      | `…/:id`                               | `view`   | datos con etiquetas en español, estado derivado con días, propietario o vehículo por número económico, historial de revisiones paginado (carga, error, más), archivado, aviso de éxito, 404 uniforme, 403, 401     |
| Alta       | `…/nuevo`, `…/nueva`                  | `create` | validación por campo con foco al primero, 422 `invalid_owner` / `invalid_vehicle` junto a su campo, guardando, 400/403/5xx, sesión expirada con lo escrito conservado, flota vacía o parcial                       |
| Edición    | `…/:id/editar`                        | `edit`   | solo título y notas (documentos) o aseguradora y notas (pólizas); sin cambios, conflicto de versión (409), archivado entre tanto (409 `immutable`), solo lectura, 404, sesión expirada                             |
| Renovación | `…/:id/renovar`                       | `edit`   | nueva revisión con datos precargados (número, cobertura y deducible; la póliza propone el año siguiente), 409, `immutable`, 422 `invalid_vehicle` (póliza), el historial conserva la anterior como «Reemplazado/a» |
| Archivar   | diálogo de la ficha                   | `delete` | confirmación, en curso, conflicto de versión, ya archivado, sin permiso, no existe, error, sesión expirada                                                                                                         |

- **Clientes tipados:** `ports.documents` y `ports.insurance` se construyen con `createDocumentsClient` y `createInsuranceClient` de `@opslog/contracts`; no hay `fetch` directo. Hay pruebas de las rutas HTTP en `api/ports.test.ts`.
- **Estado derivado:** vigente / por vencer / vencido se calcula en el servidor (ventana de 30 días, último día inclusivo); la pantalla solo lo muestra, con el texto además del color.
- **Revisiones inmutables:** renovar agrega una revisión; la anterior queda en el historial. Editar solo cambia datos descriptivos.
- **Deducible (`view_costs`):** el campo solo se ofrece y se envía si la sesión tiene `view_costs`; sin el permiso la clave `deductible` no se envía nunca (el servidor responde 403 si aparece) y el formulario lo explica. En lectura, quien no tiene el permiso ve solo que existe un deducible («Registrado. Solo lo ve quien tiene permiso para ver costos.»). Los importes se convierten a unidades menores con el exponente de la moneda (`Intl`), de forma exacta y sin flotantes; un porcentaje se envía en puntos base. Al renovar sin permiso, el deducible actual se conserva sin enviarlo.
- **Selector de vehículo:** el propietario de un documento y el vehículo de una póliza se eligen de una lista cargada con `ports.vehicles.list` (hasta 500, con aviso si hay más). Nunca se pide un identificador a mano.
- **Versión optimista y sesión expirada:** igual que Vehículos (409 explicado con «Cargar datos actuales»; lo escrito se conserva en memoria si la versión no cambió).
- **PII y cantidades:** ningún `console.*`; las URLs solo llevan el id del recurso y `?aviso=` (que se retira tras mostrarse); no se usa Web Storage; los importes no aparecen en rutas, avisos ni almacenamiento. El historial muestra `actorId` (`user-<subject>`), el único identificador de persona de la fila.
- **Mock:** `createMockApi` incorpora 28 documentos y 28 pólizas sintéticos con la semántica del backend (versiones, `immutable`, 404 uniforme, `invalid_owner` / `invalid_vehicle`, enmascarado del deducible, historial, reloj fijo 2026-10-06) y controles para simular a otra persona. Las cuentas demo son las existentes: administración (todo), consulta, despacho (sin `delete` ni `view_costs`) y mecánico (ver y editar).

## Stories y baselines de píxeles

Storybook y la página de axe de todas las stories indexan también `apps/web/documents/**` y `apps/web/insurance/**`. Cada story genera dos baselines (`-desktop` 1280 y `-mobile` 360) en `e2e/visual/__snapshots__/` con la tolerancia estricta de siempre (0.002, sin reintentos), creados con `pnpm test:visual:update`.

- `Flota/Documentos/Lista` (13), `Detalle` (16), `Formulario` (12).
- `Flota/Seguros/Lista` (14), `Detalle` (19), `Formulario` (14), incluidas las variantes con deducible en monto, en porcentaje, enmascarado y sin permiso para verlo.

Las stories con modal abierto llevan `parameters.harness: 'modal'` (axe las omite en la página conjunta; el diálogo se escanea aparte en `e2e/documents.spec.ts` y `e2e/insurance.spec.ts`).

## Pruebas

- `pnpm --filter @opslog/web test:unit` (umbrales 95/95/95/90): listas, fichas, formularios, modelos de formulario, reglas, mocks, puerto HTTP, rutas y axe en jsdom.
- `pnpm test:e2e` (`e2e/documents.spec.ts`, `e2e/insurance.spec.ts`): navegación, filtros y paginación, axe con contraste medido, sin desbordamiento a 360/1280, alta con teclado, importe exacto del deducible, renovación, conflicto de versión (con botones del arnés), diálogo de archivado y roles (incluido que sin `view_costs` no hay deducible). `e2e/components.spec.ts` ahora cuenta 194 stories y amplía su tiempo límite.
- `pnpm test:visual`: regresión de píxeles de todas las stories.

## Huecos y decisiones pendientes (no se declaran cumplidos)

1. **Propietario empleado de un documento:** el contrato lo admite (`owner_type: employee`), pero no existe aún pantalla de personal; la lista y la ficha lo muestran solo como «Empleado» (sin identificador ni nombre) y el alta solo ofrece vehículos. Cuando exista Personal, el alta añadirá el selector de empleados y se resolverá el nombre mostrado.
2. **Archivos adjuntos:** los documentos son solo metadatos; la carga de archivos llega con el módulo de archivos.
3. **Corregir una revisión:** no hay edición de fechas o número de una revisión (el backend solo permite renovar). Un error de captura se corrige renovando o archivando.
4. **Restaurar archivados** y **cambio de propietario/vehículo** tras el alta: no existen en el contrato.
5. **Búsqueda por texto y orden configurable:** el listado solo filtra por los campos indicados; el orden es el del servidor.
6. **Moneda del deducible:** el formulario ofrece un código ISO de 3 letras (por omisión `MXN`); la moneda de la empresa no está en el contrato. Se valida el formato, no la existencia del código.
7. **Alertas de vencimiento (notificaciones, tablero):** fuera de alcance; el estado derivado y el filtro «vigente en una fecha» son lo único entregado.
8. **Sin OIDC real:** como en Vehículos, el shell solo arranca con el mock; `createHttpApi` ya incluye ambos módulos, pero no se ha probado contra el BFF real en navegador.
9. **Vehículo del selector:** si el vehículo de un documento o una póliza se archiva después, la ficha muestra el enlace genérico «Ver vehículo» en lugar del número económico (la lectura del vehículo es de mejor esfuerzo); no se oculta ni se bloquea.
