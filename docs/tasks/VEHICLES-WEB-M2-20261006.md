# VEHICLES-WEB-M2-20261006 — pantallas de Vehículos (lista, ficha, alta, edición y archivado)

```yaml
id: VEHICLES-WEB-M2-20261006
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
baseSHA: 3aca09842f35ff5a5d6cc3d3d3fa3b2bee11ef21
depends_on: [VEHICLES-M2-20261006, CORE-WEB, ADR-0010]
write_paths:
  [
    apps/web/vehicles/**,
    apps/web/app/**,
    apps/web/api/**,
    packages/ui/src/components/ConfirmDialog*,
    packages/ui/src/index.ts,
    packages/ui/src/a11y.test.tsx,
    packages/ui/.storybook/main.ts,
    e2e/**,
    docs/tasks/VEHICLES-WEB-M2-20261006.md,
    package.json,
  ]
```

Pantallas de Vehículos sobre el backend ya fusionado (`VEHICLES-M2-20261006`). ADR-0010 queda satisfecho (Storybook y regresión visual existen desde #45), así que las pantallas nuevas son admisibles **a condición de** tener stories con baselines de píxeles en 1280 y 360: todas las de este documento las tienen. Solo datos sintéticos; sin AWS ni OIDC real; sin cambios de backend. `VIN` sigue siendo único por empresa (pregunta abierta 9 del slice de backend, resuelta por el propietario el 2026-10-06: no se toca).

## Alcance entregado

| Pantalla | Ruta                          | Permiso  | Estados cubiertos                                                                                                                                                                                |
| -------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lista    | `/flota/vehiculos`            | `view`   | carga, vacío (con y sin permiso para crear), sin resultados, error con reintento, sin permiso (403), sesión expirada (401), «cargar más» (en curso y fallido), filtro de área inválido           |
| Ficha    | `/flota/vehiculos/:id`        | `view`   | carga, error, no encontrado (404 uniforme), sin permiso, sesión expirada, archivado, dado de baja, aviso de éxito (alta, guardado, archivado)                                                    |
| Alta     | `/flota/vehiculos/nuevo`      | `create` | validación por campo, duplicados por campo, guardando, errores 400/403/5xx, sesión expirada con lo escrito conservado                                                                            |
| Edición  | `/flota/vehiculos/:id/editar` | `edit`   | datos cargados, sin cambios, conflicto de versión (409), odómetro menor (cliente y 422), guardado parcial, archivado entre tanto (409 `immutable`), solo lectura, no encontrado, sesión expirada |
| Archivar | diálogo de la ficha           | `delete` | confirmación, en curso, conflicto de versión, ya archivado, sin permiso, no existe, error, sesión expirada                                                                                       |

- **Cliente tipado:** `ports.vehicles` se construye con `createVehiclesClient` de `@opslog/contracts` (no hay `fetch` directo). El puerto expone solo lo que usan las pantallas (listar, leer, crear, editar, odómetro, archivar); cambio de estado e historial existen en el contrato pero no tienen pantalla.
- **Permisos:** la navegación («Flota → Vehículos») y cada acción dependen de `view`, `create`, `edit` y `delete` (archivar). El servidor sigue siendo la autoridad: un 403 muestra el estado sin permiso. Un vehículo archivado o dado de baja es de solo lectura (sin «Editar»).
- **Versión optimista:** cada cambio lleva la `version` leída. Un 409 `stale_version` se explica («Otra persona modificó este vehículo… Tus cambios no se guardaron») y ofrece «Cargar datos actuales». Un 409 `duplicate` marca el campo (número económico, placa o VIN) sin repetir el valor.
- **Odómetro (BR-015):** el odómetro tiene su propio comando en el backend, así que la edición hace primero el cambio de campos (`PUT`) y luego la lectura (`POST odometer`) con la versión resultante. Un valor menor se rechaza en el formulario antes de enviar; si aun así el servidor responde 422 (otra persona subió la lectura), el mensaje queda junto al campo, se aclara qué sí se guardó y el reintento envía solo el odómetro.
- **Sesión expirada:** el formulario permanece montado e inerte (CORE-WEB). La alta conserva lo escrito en memoria de la página. La edición lo conserva solo si, al volver a iniciar sesión, el vehículo sigue en la misma versión; si cambió, se cargan los datos actuales y se avisa, para no pisar el trabajo de otra persona. No se usan borradores de servidor ni Web Storage.
- **Foco y teclado:** el diálogo de archivado (nuevo `ConfirmDialog` en `@opslog/ui`) atrapa el foco, empieza en «Cancelar», se cierra con Escape y devuelve el foco a «Archivar»; un envío con errores enfoca el primer campo inválido (o el aviso si el error es del servidor); la navegación a la ficha usa el enfoque de contenido del shell.
- **PII:** ningún `console.*`; los errores del cliente no incluyen valores (el 409 solo nombra el campo); las pantallas no registran ni muestran identificadores de personas (los vehículos no contienen PII).
- **Mock:** `createMockApi` incorpora una flota sintética (28 vehículos, 6 estados, 3 áreas) con la semántica del backend (versiones, `immutable`, duplicados por empresa, odómetro, 404 uniforme) y controles para simular cambios de otra persona; el rol «Despachador» (`view`, `create`, `edit`, sin `delete`) se expone como cuenta de demostración.

## Stories y baselines de píxeles

Storybook ahora indexa también `apps/web/vehicles/**/*.stories.tsx` (`packages/ui/.storybook/main.ts`, con alias de `@opslog/ui` y `@opslog/contracts`). Cada story genera dos baselines (`-desktop` 1280 y `-mobile` 360) en `e2e/visual/__snapshots__/` con la tolerancia estricta de siempre (0.002, sin reintentos).

- `Foundations/Dialogo de confirmacion`: Default, Busy, WithError (nuevo componente).
- `Flota/Vehiculos/Lista` (14): Default, ReadOnly, LastPage, LoadingMore, LoadMoreFailed, FilteredWithArchived, InvalidAreaFilter, NoResults, Empty, EmptyReadOnly, Loading, Error, NoPermission, SessionExpired.
- `Flota/Vehiculos/Detalle` (16): Default, WithoutVin, ReadOnly, EditorWithoutArchive, JustCreated, JustSaved, Decommissioned, Archived, ArchiveConfirmation, ArchiveInProgress, ArchiveConflict, Loading, Error, NotFound, NoPermission, SessionExpired.
- `Flota/Vehiculos/Formulario` (11): Create, CreateValidationErrors, CreateDuplicates, CreateSaving, Edit, EditSaving, EditVersionConflict, EditOdometerDecrease, EditNotEditable, EditNotFound, NoPermission.

Las stories son CSF plano (sin tipos de Storybook: el paquete web no depende de él). Las que abren un modal llevan `parameters.harness: 'modal'`: la página de axe que monta todas las stories (`e2e/browser-app/stories.tsx`) las omite porque un modal oculta el resto de la página por diseño; el diálogo se escanea aparte con axe en `e2e/vehicles.spec.ts` (y en jsdom).

## Pruebas

- `pnpm --filter @opslog/web test:unit` (umbrales 95/95/95/90): lista, ficha, formularios, diálogo, mock, modelo de formulario, puerto HTTP, rutas y axe en jsdom.
- `pnpm --filter @opslog/ui test` y `axe`: `ConfirmDialog` (foco, Escape, ocupado, error) y axe.
- `pnpm test:e2e` (`e2e/vehicles.spec.ts`): navegación, filtros y paginación, axe con contraste medido en lista, ficha y formularios, sin desbordamiento a 360/1280, alta solo con teclado, duplicado, odómetro, conflicto de versión, diálogo (foco atrapado y devuelto, Escape, axe) y roles.
- `pnpm test:visual`: regresión de píxeles de todas las stories.

## Huecos y decisiones pendientes (no se declaran cumplidos)

1. **Cambio de estado e historial** (FR-072/077): el backend existe (`vehicles.status`, `vehicles.history`), pero no están en el alcance pedido y no tienen pantalla; el estado solo se muestra.
2. **Áreas:** el módulo de Áreas ya existe (`AREAS-WEB-M2-20261006`) y el backend valida el `areaId` (422 `invalid_area`, campo `area_id`: la pantalla lo muestra junto al campo y el mock lo reproduce), pero el filtro y el campo de vehículos siguen siendo un identificador de texto; convertirlos en un selector del catálogo queda pendiente.
3. **Búsqueda por texto** (número económico, placa, VIN): el listado del backend solo filtra por estado, área y archivados; no hay búsqueda ni orden configurable.
4. **Edición no atómica:** el odómetro tiene un comando propio, así que guardar campos y lectura son dos llamadas (con el manejo de guardado parcial descrito). Un `PUT` que admita el odómetro, o un comando transaccional, lo simplificaría; no se construyó por no ser necesario para las pantallas.
5. **Corrección del odómetro hacia abajo** (BR-015, con permiso y motivo): el backend la rechaza siempre; la pantalla lo explica y no la ofrece.
6. **Restaurar archivados** y **permisos por módulo** (`pii_reader` puede crear vehículos): preguntas abiertas 1 y 2 del slice de backend.
7. **VIN único por empresa:** desviación del BRD aprobada por el propietario el 2026-10-06 (pregunta abierta 9 del backend, resuelta).
8. **Sin OIDC real:** el shell solo arranca con el mock en desarrollo (`createHttpApi` ya incluye los vehículos, pero ningún servidor acepta aún el proveedor falso), por lo que la pantalla no se ha probado contra el BFF real en navegador.
9. En desarrollo, `React.StrictMode` ejecuta dos veces el efecto del atrapa-foco de MUI y descarta `autoFocus`; `ConfirmDialog` lo corrige al terminar la transición de apertura.
