# FND-DS — contrato de diseño v1

`packages/ui` centraliza tokens OPSLOG, tema Material UI y componentes base sin acoplar reglas de autorización ni pantallas funcionales.

## Catálogo de estados

`UiState` cubre loading, vacío, sin resultados, error recuperable, sin permiso, incompleto, vencido, cerrado, éxito y sesión expirada. Cada estado comunica texto y no depende únicamente del color. Las stories son sintéticas.

## Accesibilidad

- Foco visible global mediante `:focus-visible`.
- Estados con `role=status` o `role=alert`.
- Acciones con botones nativos, navegables por teclado.
- Estado y severidad son propiedades separadas en `StatusBadge`.
- La verificación automatizada WCAG/axe queda pendiente de FND-REPO.

## Integración

Importar `opslogTheme`, `opslogTokens`, `UiState`, `StatusBadge` y los componentes base desde el entrypoint. Las etiquetas usan lenguaje de usuario y no exponen identificadores técnicos de permisos.

## Catálogo implementado

El entrypoint exporta `Button`, `Field`, `FormSection`, `SeverityBadge`, `DataTable`, `FilterBar`, `PageHeader`, `DetailTabs`, `Wizard`, `Timeline`, `NextStepPanel`, `ConfirmWithReason`, `UploadQueue` y `Notifications`. Sus stories usan exclusivamente datos sintéticos; no contienen pantallas funcionales ni decisiones de autorización.

`StatusBadge` expone a tecnologías de asistencia el estado, la severidad y la descripción cuando están disponibles. La auditoría automatizada axe y los snapshots siguen dependiendo de la infraestructura de FND-REPO.
