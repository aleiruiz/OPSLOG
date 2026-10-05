# FND-DS — contrato de diseño v1

`packages/ui` centraliza tokens OPSLOG, tema Material UI y componentes base sin acoplar reglas de autorización ni pantallas funcionales.

## Catálogo de estados

`UiState` cubre loading, vacío, sin resultados, error recuperable, sin permiso, incompleto, vencido, cerrado, éxito y sesión expirada. Cada estado comunica texto y no depende únicamente del color. Las stories son sintéticas.

## Accesibilidad

- Foco visible global mediante `:focus-visible`.
- Estados con `role=status` o `role=alert`.
- Acciones con botones nativos, navegables por teclado.
- Estado y severidad son propiedades separadas en `StatusBadge`.
- axe corre en jsdom para `StatusBadge` y `UiState` (`pnpm --filter @opslog/ui axe`) y, para toda la galería incluidos los 14 componentes base, en un navegador real (`e2e/components.spec.ts`, `@axe-core/playwright`, etiquetas WCAG 2.1 A/AA). Allí el contraste se mide de verdad; jsdom no puede calcularlo. Axe marca como "incompletos" los glifos sin texto y los inputs bajo el contorno, que no puede decidir automáticamente.

## Integración

Importar `opslogTheme`, `opslogTokens`, `UiState`, `StatusBadge` y los componentes base desde el entrypoint. Las etiquetas usan lenguaje de usuario y no exponen identificadores técnicos de permisos.

## Catálogo implementado

El entrypoint exporta `Button`, `Field`, `FormSection`, `SeverityBadge`, `DataTable`, `FilterBar`, `PageHeader`, `DetailTabs`, `Wizard`, `Timeline`, `NextStepPanel`, `ConfirmWithReason`, `UploadQueue` y `Notifications`. Sus stories usan exclusivamente datos sintéticos; no contienen pantallas funcionales ni decisiones de autorización.

`StatusBadge` expone a tecnologías de asistencia el estado, la severidad y la descripción cuando están disponibles.

`EmptyState`, `ErrorState` y `PermissionState` del catálogo se implementan como variantes de `UiState` (`empty`/`no-results`, `error`/`session-expired`, `no-permission`), no como componentes con nombre propio.

## Escalas, fuentes, stories y snapshots

- Tokens de escala: `typography.sizes` (14/22/16 px) y `spacingScale` (4/8/12/16/24/32/48) siguen SPECS §8 y alimentan el tema.
- Fuentes: IBM Plex Sans y Mono se autoalojan desde paquetes npm fijados (`packages/ui/src/fonts.ts`), sin CDN.
- Snapshots: el árbol de accesibilidad de la galería se compara con `e2e/components.spec.ts-snapshots/gallery.aria.yml`. **Diferido explícitamente:** snapshots de píxeles (dependen del renderer de CI) y un runtime de Storybook; las stories `*.stories.tsx` se renderizan en el navegador con un renderizador CSF mínimo (`e2e/browser-app/stories.tsx`) y se escanean con axe (WCAG 2.1 A/AA); un runtime de Storybook queda diferido a antes de la primera pantalla funcional y no más tarde de G1. Las fuentes IBM Plex se cargan desde el entrypoint del paquete (`packages/ui/src/fonts.ts`). El indicador de foco es un contorno sólido de 3px con offset 2px, verificado por teclado en `e2e/components.spec.ts`.

## Borde de campos de texto

Los campos usan el token `inputBorder` (`#6B7280`, aprox. 4,8:1 sobre la superficie y 4,2:1 sobre el fondo de página) para cumplir WCAG 1.4.11 (contraste de componentes ≥3:1). Es una desviación deliberada de la paleta de bordes de la referencia (`#E3E6EB`/`#C9CFD8`), que se conserva para divisores y tarjetas.
