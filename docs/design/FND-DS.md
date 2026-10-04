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

## Trazabilidad

| Requisito                             | Contrato                             | Implementación                                  | Prueba                                          | Evidencia                           |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Tokens centralizados y tema ampliable | Tokens OPSLOG y `opslogTheme`        | `packages/ui/src/tokens.ts`, `theme.ts`         | Typecheck/build del paquete UI en FND-INTEGRATE | CI del candidato de integración     |
| Estados operativos completos          | `UiStateKind` y `UiStateProps`       | `packages/ui/src/components/UiState.tsx`        | Stories sintéticas y pruebas UI                 | CI/axe del candidato de integración |
| Estado y severidad separados          | `StatusTone`, `StatusBadgeProps`     | `packages/ui/src/components/StatusBadge.tsx`    | Story de estados y prueba accesible             | CI/axe del candidato de integración |
| Navegación y foco accesibles          | Elementos nativos y `:focus-visible` | `packages/ui/src/components/BaseComponents.tsx` | Pruebas de teclado/axe                          | CI/axe del candidato de integración |

El paquete se mantiene aislado en FND-DS. El registro workspace, dependencias React/MUI, cobertura, axe ejecutable y comandos globales de Prettier pertenecen a FND-INTEGRATE; no se simula evidencia de esas validaciones en este PR.
