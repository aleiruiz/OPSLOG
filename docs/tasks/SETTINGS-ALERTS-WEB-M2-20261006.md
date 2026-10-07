# SETTINGS-ALERTS-WEB-M2-20261006 — pantallas de Alertas de vencimiento y Ajustes de alertas (lista, filtros, ajustes con versión, resumen en Inicio)

```yaml
id: SETTINGS-ALERTS-WEB-M2-20261006
baseline:
  [
    SPEC-1.3,
    ORCH-1.3,
    inherited: SPEC-1.0/ORCH-1.0,
    SPEC-1.1/ORCH-1.1,
    SPEC-1.2/ORCH-1.2,
    SPEC-1.3/ORCH-1.3,
  ]
milestone: M2
kind: implementation
slice: web
baseSHA: d11627091b97ace627a7fc461562eed9368c5aee
depends_on:
  [
    SETTINGS-ALERTS-M2-20261006,
    DOCS-INSURANCE-WEB-M2-20261006,
    VEHICLES-WEB-M2-20261006,
    CORE-WEB,
    ADR-0010,
  ]
write_paths:
  [
    apps/web/alerts/**,
    apps/web/app/**,
    apps/web/api/**,
    apps/web/tsconfig.json,
    apps/web/vitest.config.ts,
    packages/ui/.storybook/main.ts,
    e2e/**,
    docs/tasks/SETTINGS-ALERTS-WEB-M2-20261006.md,
    package.json,
  ]
```

La autoridad de esta asignación es la instrucción directa del usuario que fija SPEC-1.3/ORCH-1.3. En esta rama, `docs/baselines/ACTIVE.md` y otros paquetes de tarea aún declaran 1.4; la discrepancia queda registrada aquí sin modificar ni adoptar baselines o manifests.

Pantallas sobre el backend ya fusionado (`GET /api/alerts`, `GET/PUT /api/alerts/settings`, cliente `createAlertsClient`), con el mismo patrón que Documentos y Seguros. Solo datos sintéticos; sin cambios de backend ni de `@opslog/ui`. ADR-0010: todas las pantallas tienen stories con baselines en 1280 y 360.

## Alcance entregado

| Pantalla           | Ruta                               | Permiso                                   | Estados cubiertos                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alertas            | `/flota/alertas` (Flota > Alertas) | `view`                                    | carga, vacío, sin resultados, error con reintento, 403, 401, «cargar más» (en curso y fallido), filtros (origen, estado, vehículo), vehículos no disponibles, ventana de la empresa y fecha del servidor en la descripción                                   |
| Ajustes de alertas | `/configuracion/alertas`           | lectura `view`, escritura `manage_config` | formulario editable con `manage_config`; vista de solo lectura para el resto; sin guardar previo (versión 0), guardado, validación por campo con foco al primero, «sin cambios», 409 `stale_version`, 400/403/5xx, sesión expirada con lo escrito conservado |
| Resumen en Inicio  | `/`                                | `view`                                    | totales de vencidos y por vencer con enlace a la lista; cargando, error con reintento, nada pendiente; se oculta con 403 o sesión expirada                                                                                                                   |

- **Clientes tipados:** `ports.alerts` es `createAlertsClient` (sin `fetch` directo); prueba de rutas en `api/ports.test.ts`.
- **Alertas derivadas:** el servidor las deriva en cada lectura; la pantalla solo lista. Cada fila enlaza al documento o a la póliza de origen y al vehículo (número económico; genérico si los vehículos no cargan). Solo se muestran tipo, origen, fecha y días: el contrato no trae títulos, números ni personas.
- **Versión optimista:** el guardado envía la versión de la última lectura (0 si nunca se guardó). Un 409 `stale_version` se explica («Otra persona cambió los ajustes… Tus cambios no se guardaron») con «Cargar datos actuales», que descarta lo escrito y recarga. Tras una sesión expirada lo escrito se conserva solo si la versión no cambió; si cambió, se avisa.
- **Navegación:** «Alertas» en Flota para todos con `view`. «Ajustes de alertas» en Configuración solo aparece con `manage_config` (nueva opción `nav.requires` en las rutas); el resto llega por el botón «Ajustes de alertas» de la lista y ve los valores en solo lectura.
- **Mock:** `createMockApi` deriva las alertas de los documentos y pólizas del propio mock (34 con los datos demo: 12 vencidos, 22 por vencer; reloj fijo 2026-10-06), con la semántica del backend (ventana inclusiva, archivados y empleados excluidos, orden, cursor, 400 uniforme, versión 0, 409) y controles `changeAlertSettingsExternally` y `alertSettings`.

## Stories y baselines de píxeles

Storybook y la página de axe indexan `apps/web/alerts/**`: `Flota/Alertas/Lista` (13) y `Configuración/Alertas` (15: formulario, conflicto, solo lectura y resumen de Inicio). Cada story genera baselines `-desktop` (1280) y `-mobile` (360), creados con `pnpm test:visual:update`. `e2e/components.spec.ts` cuenta 285 stories.

## Pruebas

- `pnpm --filter @opslog/web test:unit` (umbrales 95/95/95/90): lista, ajustes, resumen, modelo de formulario, etiquetas, mock, puerto HTTP, rutas y axe en jsdom.
- `e2e/alerts.spec.ts`: navegación, filtros y paginación, enlaces al origen, resumen en Inicio, axe con contraste medido, sin desbordamiento a 360/1280, permisos (editable, solo lectura, sin entrada de menú), guardado con teclado, validación con foco y conflicto de versión (botón del arnés).

## Huecos y decisiones pendientes (no se declaran cumplidos)

1. **Filtro por área y por «vigente a la fecha» (`coversOn`):** el backend de alertas no los expone (solo origen, estado y vehículo); no se simulan en el navegador.
2. **Filtro por tipo de documento o cobertura:** tampoco existe en el contrato.
3. **Sin entrega de avisos:** los destinatarios son un dato de configuración; ningún envío los usa todavía (la pantalla lo dice). Documentos de empleados no generan alertas en el backend.
4. **Ventana máxima 30 días:** el estado «por vencer» de documentos y seguros usa siempre 30 días; la ayuda del campo lo explica. Ampliarla requiere cambio de backend.
5. **Paginación acotada:** el servidor no emite cursor más allá de 2 000 alertas; la pantalla simplemente deja de ofrecer «Cargar más».
6. **Resumen de Inicio:** usa dos lecturas con límite 25 solo por sus totales; un endpoint de conteo sería más barato.
7. **Roles como destinatarios:** los nombres en español son de la interfaz (admin = Administración de la empresa, editor = Responsable de flotilla); no hay selector de personas ni correos.
8. **Sin OIDC real:** como en las demás pantallas, solo se ha probado contra el mock; `createHttpApi` ya incluye `alerts`.
