# EMPLOYEES-WEB-M2-20261006 — pantallas de Empleados (lista, ficha, alta, edición, estado y archivado)

```yaml
id: EMPLOYEES-WEB-M2-20261006
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
baseSHA: 6f5470bb5fc17e589ca313103aa03ae0d655e431
depends_on: [EMPLOYEES-M2-20261006, AREAS-WEB-M2-20261006, VEHICLES-WEB-M2-20261006, ADR-0010]
write_paths:
  [
    apps/web/employees/**,
    apps/web/areas/**,
    apps/web/app/**,
    apps/web/api/**,
    apps/web/vehicles/**,
    apps/web/tsconfig.json,
    apps/web/vitest.config.ts,
    packages/ui/.storybook/main.ts,
    e2e/**,
    docs/tasks/EMPLOYEES-WEB-M2-20261006.md,
    docs/tasks/AREAS-WEB-M2-20261006.md,
    docs/tasks/VEHICLES-WEB-M2-20261006.md,
    package.json,
  ]
```

Pantallas de Empleados (FLT-UI-PEOPLE, parte de empleados) sobre el backend fusionado (`EMPLOYEES-M2-20261006`). Solo datos sintéticos (identificaciones «EJEM…», correos `@ejemplo.test`, teléfonos de rango ficticio); sin AWS ni OIDC real; sin cambios de backend (`apps/api`, `packages/domain`, `packages/persistence`, `packages/contracts` no se tocan). Cada pantalla y estado tiene story con baselines de píxeles a 1280 y 360 (ADR-0010).

## Alcance entregado

| Pantalla | Ruta                              | Permiso                                           | Estados cubiertos                                                                                                                                                                                                                                             |
| -------- | --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lista    | `/plantilla/empleados`            | `view`                                            | filtros tipo, estado, área (selector) y archivados; «cargar más» con cursor firmado (en curso y fallido); insignia de aptitud en conductores; vacío (con y sin permiso para crear), sin resultados, carga, error con reintento, sin permiso, sesión expirada  |
| Ficha    | `/plantilla/empleados/:id`        | `view`                                            | datos, área enlazada, estado con motivo, aptitud con sus razones, historial paginado, datos personales ocultos o mostrados bajo petición, avisos de éxito, baja/archivado (solo lectura), carga/error/no encontrado/sin permiso/sesión expirada               |
| Alta     | `/plantilla/empleados/nuevo`      | `create` (+ `view_pii` para los datos personales) | tipo, número, nombre, puesto, ingreso, área (solo activas), licencia (conductores), datos personales (solo con `view_pii`); errores por campo y de servidor (409 duplicado por campo, 422 `invalid_area`); guardando; borrador conservado si expira la sesión |
| Edición  | `/plantilla/empleados/:id/editar` | `edit` (+ `view_pii` para los datos personales)   | tipo inmutable, sin cambios, solo lo modificado, conflicto de versión, 409 `immutable`, baja/archivado no editable, no encontrado, borrador restaurado solo si la versión no cambió                                                                           |
| Estado   | ficha (panel «Cambiar estado»)    | `edit`                                            | solo los destinos que permite la matriz, motivo obligatorio (≤ 200), en curso, 409 `stale_version`/`invalid_transition`/`immutable`, 400/403/404/5xx, 401; la baja pide confirmación                                                                          |
| Diálogos | ficha                             | archivar `delete`                                 | archivar y dar de baja (`ConfirmDialog`): confirmación, en curso, conflicto de versión, 403/404/5xx, 401                                                                                                                                                      |

- **Navegación:** «Empleados» va en el grupo **«Plantilla»** (antes de «Áreas»), permiso genérico `view`.
- **Cliente tipado:** `ports.employees` se construye con `createEmployeesClient` (sin `fetch` directo, sin Web Storage).
- **Datos personales (PII):** el BFF no tiene una lectura sin PII: `get` siempre descifra y audita `employee.pii_viewed` para quien tiene `view_pii` (ver hueco 1). La pantalla lo mitiga: los valores llegan a memoria pero **no se pintan** hasta que la persona pulsa «Mostrar datos personales»; «Ocultar» los vuelve a ocultar y al cambiar la versión (estado, archivado) vuelven a estar ocultos. Sin `view_pii` el servidor devuelve `pii: null` y solo se muestra un marcador «Datos personales protegidos» con qué datos existen (banderas `piiPresent`), sin botón. La lista nunca trae PII.
- **Formularios y PII:** los campos personales (identificación y su tipo, teléfono, correo y número de licencia) solo existen con `view_pii`; sin él se sustituyen por un aviso y **no se envían** (el servidor responde 403 si llegan, antes de revisar duplicados). En edición se envía únicamente lo modificado; vaciar un campo opcional envía `null`.
- **Tipo inmutable:** el tipo (conductor, despachador, otro) solo se elige al crear; en edición el selector está bloqueado. La sección de licencia solo aparece en conductores.
- **Área por selector:** el área se elige de las áreas **activas** (árbol con sangría), nunca como id libre. En edición el área actual sigue seleccionable aunque se haya desactivado. Si ya no hay áreas activas el formulario lo explica y enlaza a Áreas. El 422 `invalid_area` se muestra junto al campo.
- **Aptitud para operar (conductores):** insignia en la lista y fila en la ficha con las razones en palabras (`not_active`, `archived`, `license_missing`, `license_expired`). La calcula el servidor; el mock la deriva igual.
- **Estado:** el panel ofrece solo transiciones válidas (`active`⇄`inactive`/`suspended`, cualquiera → `terminated`); `terminated` es terminal: pide `ConfirmDialog` mostrando el motivo y deja el registro de solo lectura. Archivar (BR-009) pide confirmación y está permitido desde cualquier estado.
- **Foco:** envíos con errores enfocan el primer campo inválido o el aviso; tras cambiar estado o archivar, el foco pasa al aviso de resultado; diálogos con foco atrapado, inicio en «Cancelar», Escape y retorno del foco.
- **Mock:** `createMockEmployeeStore` reproduce el backend (versiones, 409 `stale_version`/`immutable`/`invalid_transition`/`duplicate` con campo, 422 `invalid_area`, 400/404 uniformes, cursor, orden por apellido, aptitud derivada, historial, enmascarado de PII y 403 al escribir PII sin `view_pii`, auditoría `employee.pii_viewed` solo si hay algo que revelar). Cuenta empleados vivos para el bloqueo `area_in_use` (`people`) de Áreas (BR-021), que antes era 0.

## Cambios acordados fuera de Empleados

- **Rol y cuenta de demostración nuevos en el mock:** el rol `role-pii` «Responsable de datos personales» (`view`, `create`, `view_pii`, como el `pii_reader` real) y la cuenta `cuenta-datos`. No existía ningún rol del mock con `view_pii` sin ser administrador. Efecto: 8 roles y 28 usuarios en el mock (pruebas de Roles/Usuarios y `e2e/web-shell.spec.ts` ajustadas).
- **Vehículos:** el campo de área del formulario deja de ser un id de texto y pasa al mismo selector de áreas activas (`areas/AreaSelect`, `areas/areaChoices`); aviso con enlace si no hay áreas activas; en edición el área actual se conserva aunque esté inactiva. El filtro de área de la **lista** de vehículos sigue siendo texto (seguimiento).
- `e2e/components.spec.ts`: el recuento de stories pasa de 112 a 175 y el test tiene 120 s de margen (una pasada de axe sobre todas las stories).

## Stories y baselines

Storybook indexa `apps/web/employees/**/*.stories.tsx`. Cada story tiene `-desktop` (1280) y `-mobile` (360), tolerancia estricta sin reintentos, generadas con el Chromium por defecto de Playwright 1.56.1 (`pnpm test:visual:update`, sin `OPSLOG_CHROMIUM_PATH` ni `playwright install`).

- `Plantilla/Empleados/Lista` (13): Default, ReadOnly, LastPage, LoadingMore, LoadMoreFailed, FilteredWithArchived, NoResults, Empty, EmptyReadOnly, Loading, Error, NoPermission, SessionExpired.
- `Plantilla/Empleados/Detalle` (37): Default, PersonalDataRevealed, PersonalDataMaskedForRole, ReadOnly, EditorWithoutArchive, Dispatcher, WithoutOptionalData, NotFitLicenseExpired, NotFitNoLicense, Suspended, Terminated, Archived, UnknownArea, JustCreated/Saved/ChangedStatus, History (WithMore/LoadingMore/LoadMoreFailed/Loading/Error), StatusPanel (Open/Filled/Busy/Conflict/FromSuspended), Archive (Confirmation/InProgress/Conflict), Terminate (Confirmation/InProgress/Conflict), Loading, NotFound, Error, NoPermission, SessionExpired.
- `Plantilla/Empleados/Formulario` (18): Create, CreateDriver, CreateValidationErrors, CreateDuplicates, CreateInvalidArea, CreateWithoutPersonalDataAccess, CreateNoAreas, CreateSaving, Edit, EditWithoutPersonalDataAccess, EditWithoutPersonalDataOnFile, EditSaving, EditNothingToSave, EditVersionConflict, EditEmployeeClosed, EditOutdatedDraft, NotEditable, NotFound.
- `Flota/Vehiculos/Formulario`: baselines regeneradas (selector de área) y nueva `CreateNoAreas`.

Las stories con modal llevan `harness: 'modal'` (el diálogo se escanea aparte con axe en `e2e/employees.spec.ts` y en jsdom).

## Pruebas

- `pnpm --filter @opslog/web test:unit` (95/95/95/90): lista, ficha (datos, PII enmascarada/mostrada y auditoría, acciones por rol, estado, archivado, historial), formularios (alta/edición, PII por permiso, duplicados, 422, conflictos, 401), modelo, reglas, mensajes, mock (41), puerto, rutas, selector de áreas y axe en jsdom.
- `pnpm test:e2e` (`e2e/employees.spec.ts`): navegación, filtros y cursor, axe con contraste medido en todas las pantallas, sin desbordamiento a 360/1280, PII oculta hasta pedirla y enmascarada por rol, alta con teclado, duplicado, edición (tipo bloqueado, selector de área), cambio de estado, diálogos (foco atrapado y devuelto, Escape, axe) y archivado.
- `pnpm test:visual`: regresión de píxeles de todas las stories.

## Trazabilidad

| Requisito                                                  | Pruebas                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lista con filtros tipo/estado/área/archivados y cursor     | `EmployeesScreen.test`, `mockEmployees.test`, `e2e/employees.spec.ts`                                   |
| Alta y edición, tipo inmutable, duplicados, `invalid_area` | `EmployeeFormScreen.test`, `formModel.test`, `messages.test`                                            |
| PII solo con `view_pii`, auditada, nunca en la lista       | `EmployeeDetailScreen.test` (PII), `EmployeeFormScreen.test`, `mockEmployees.test`, `mockApi.test`, e2e |
| Estado con motivo, matriz de transiciones, baja terminal   | `EmployeeDetailScreen.test` (estado), `rules.test`, `mockEmployees.test`                                |
| BR-009 archivado, solo lectura                             | `EmployeeDetailScreen.test` (archivo), `EmployeeFormScreen.test`, e2e                                   |
| Aptitud para operar de conductores                         | `rules.test`, `EmployeesScreen.test`, `EmployeeDetailScreen.test`                                       |
| BR-021 empleados bloquean desactivar un área               | `mockApi.test`, `mockEmployees.test` (`countLiveInArea`)                                                |
| Selector de áreas activas (empleados y vehículos)          | `areaChoices.test`, `EmployeeFormScreen.test`, `VehicleFormScreen.test`                                 |
| Accesibilidad (WCAG 2.1 AA, teclado)                       | `employees/accessibility.test`, `e2e/employees.spec.ts`, `e2e/components.spec.ts`                       |

## Huecos y decisiones pendientes (no se declaran cumplidos)

1. **No hay lectura de un empleado sin PII (principal).** `GET /employees/:id` siempre descifra y audita `employee.pii_viewed` para quien tiene `view_pii`, aunque la persona no pida verla; además la edición solo puede cargar los valores actuales así. La pantalla oculta los valores hasta una acción explícita, pero la auditoría se registra al abrir la ficha, no al pulsar «Mostrar». Propuesta al backend: parámetro (`?pii=0`) o endpoint de «revelar» para que la divulgación sea la acción auditada; entonces la ficha cargaría sin PII y solo pediría los valores al pulsar el botón (y al editar).
2. **Catálogo de tipos de identificación inventado:** `ine`, `curp`, `rfc`, `passport` (el contrato solo exige un código). Un código que el catálogo no conoce se muestra tal cual y sigue siendo seleccionable. Hace falta el catálogo oficial.
3. **`pii_reader` puede crear empleados** (permiso genérico `create`, pregunta abierta 1 del backend); la UI lo refleja. El rol y la cuenta del mock para probarlo son una ampliación mínima documentada arriba.
4. **Filtro de área de la lista de vehículos** sigue siendo texto libre; el formulario ya usa selector. Queda convertirlo.
5. **La ficha carga el catálogo de áreas** para nombrar el área (requiere `view` en Áreas); si falla (salvo 401) se muestran los ids y el empleado sigue visible.
6. **Orden y búsqueda:** el listado solo ordena por apellido y no busca por texto (backend); no hay filtro por aptitud (fuera de alcance del backend).
7. **Historial:** ids opacos de actor y nombres de área de la estructura cargada; sin nombres de persona (política de PII). Los motivos del historial son texto libre del operador: no debería contener PII, no se valida.
8. **Empleado archivado y recontratación:** conserva sus claves únicas y no hay desarchivado (pregunta abierta 4 del backend): un alta con el mismo número, identificación o correo responde 409 `duplicate`, que la pantalla muestra por campo.
9. **Sin OIDC real:** las pantallas no se han probado contra el BFF real en navegador, solo contra el mock fiel.
10. **Formularios de vehículo y áreas:** el formulario de vehículos ahora necesita `areas.list` (permiso `view` en Áreas) para cargar; sin él no se muestra el formulario.
11. **Catálogo de áreas truncado:** el selector carga el catálogo con tope de 2,000 áreas (20 páginas de 100); más allá queda truncado y las áreas restantes no se pueden elegir.
