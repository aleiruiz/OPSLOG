# ADR-0013 — Rediseño visual: tema OPSLOG v2 sobre Material UI

Estado: **aceptado por el propietario el 2026-10-13 01:44 UTC** («si», en el hilo del proyecto, tras ver las capturas del piloto y los ajustes de espaciado).
Fecha: 2026-10-13.
Origen: instrucción directa del propietario en el hilo del proyecto (2026-10-13 00:11 UTC): «necesito un rediseño serio de este proyecto, hay demasiados problemas visuales… no tiene ningún tipo de appeal. Necesitamos usar algún design system, como Material UI, y básicamente rehacer la parte visual de todo el proyecto».

## Contexto

La web ya usa Material UI 6 (`@mui/material` en `packages/ui` y `apps/web`) con un tema propio (`packages/ui/src/theme.ts`) alimentado por los tokens de SPECS §8. El problema no es la falta de un design system sino **cómo se aplicó**:

- Barra superior y menú lateral en azul marino casi negro (#0F1420) que dominan la pantalla y se ven pesados.
- Contenido sin agrupar: filtros, avisos y tablas flotan sobre el fondo gris, sin tarjetas ni jerarquía.
- Escala tipográfica plana (H1 22px y todo lo demás 16/14px), cabeceras de tabla iguales al cuerpo.
- Sin iconos en la navegación ni en las acciones; insignias de estado cuadradas y grandes.
- El `main` recibe foco programático al navegar y el anillo de foco enmarca toda la página.
- En móvil el menú lateral ocupa la pantalla completa antes del contenido.

SPECS §8 manda «aplicar el artifact mediante theme Material UI y componentes OPSLOG» y fija valores base de tokens. Por el orden de autoridad de SPECS §1, la instrucción directa del propietario prevalece sobre esos valores base; este ADR los concreta sin reducir requisitos (WCAG AA, teclado, estados por texto y no solo por color, 360px sin scroll horizontal, fuentes autoalojadas).

## Decisión

1. **Se mantiene Material UI** como design system (no se cambia de librería). Se añade `@mui/icons-material` (misma versión, 6.4.12) para la iconografía. Las pantallas siguen consumiendo componentes de `@opslog/ui`; `apps/web` no usa widgets de MUI directamente ni colores literales (guardas de `apps/web/app/guards.test.tsx`).
2. **Tema OPSLOG v2** (`packages/ui/src/tokens.ts`, `theme.ts`, `themeComponents.ts`):

   | Token | v1 (SPECS §8) | v2 |
   |---|---|---|
   | Fondo / superficie / borde | #F3F4F6 / #FFFFFF / #E3E6EB | #F5F6F8 / #FFFFFF / #E5E7EB (+ superficie sutil #F9FAFB) |
   | Texto principal / secundario | #171A1F / #3E4650 | #111827 / #4B5563 |
   | Navegación / activo | #0F1420 / #243052 (oscuro) | #FFFFFF / #EDF2FF con texto #1F43C2 (claro) |
   | Acción / hover / suave | #1F4FD8 / #1A41B2 / #E8EEFC | #2952E3 / #1F43C2 / #EDF2FF |
   | Correcto / atención / importante / crítico | #1B7A3E / #7A5000 / #A3420A / #B42318 | #127A3E / #8A5300 / #B4430E / #C0261A, cada uno con su fondo suave |
   | Fuente | IBM Plex Sans y Mono, autoalojadas | Igual; se añade el peso 500 |
   | Escala | 14 / H1 22 / H2 16 | 12 (caption) / 14 / H1 24 / H2 18 / H3–H6 16 |
   | Espaciado | 4/8/12/16/24/32/48 | Igual |
   | Geometría | Sidebar 232, contenido 24, radio 6/8 | Sidebar 248, barra superior 60, contenido 32 (máx. 1360), radio 8/12 |
   | Densidad | Filas 38/30 | Filas 44/32 |

   Todos los pares texto/fondo y estado/fondo suave tienen contraste ≥ 4.5:1 y los bordes de campo ≥ 3:1; `tokens.test.ts` lo mide.
3. **Patrones de composición** nuevos en `@opslog/ui`:
   - `Panel`: tarjeta con título, descripción, acciones, barra de herramientas y contenido (opcionalmente sin márgenes para que la tabla llegue a los bordes).
   - `StatCard`: total con etiqueta, pista e icono; opcionalmente botón de filtro rápido con `aria-pressed`.
   - `PageHeader` acepta `eyebrow` (grupo de navegación sobre el título).
   - `StatusBadge` pasa a píldora pequeña con punto de color; el texto sigue presente.
   - `DataTable`: cabecera en mayúsculas pequeñas sobre fondo sutil, filas con hover, `caption` abajo.
4. **Shell**: barra superior blanca y fija (logo, empresa, avatar con iniciales del rol, cerrar sesión), menú lateral blanco con iconos y grupos, contenido centrado con ancho máximo. Por debajo de 900px el menú se abre con el botón «Menú» (`aria-expanded`) y se cierra al navegar. El foco programático del `main` ya no dibuja anillo; el foco por teclado sí.

## Plan de migración por fases

Cada fase es un PR pequeño con su revisión de código, capturas antes/después y la regresión visual regenerada.

| Fase | Alcance | Estado |
|---|---|---|
| 0 — Piloto | Tema v2, shell, componentes base y **Alertas** (tarjetas de resumen, filtros y tablas en tarjetas). Como el tema y los componentes son compartidos, todas las pantallas cambian de aspecto ya en esta fase. | Fusionada (PR #99) |
| 1 — Inicio y Flota | Inicio (resumen con `StatCard`), Vehículos (lista y ficha), Asignaciones. Añade `DescriptionList` (datos de una ficha) y `BackLink`; Escape cierra el menú móvil. | Fusionada (PR #102) |
| 2 — Cumplimiento | Documentos, Seguros (lista y ficha), Ajustes de alertas, Importaciones. Alertas avisa que sus totales son de toda la flota cuando la lista está filtrada. | Fusionada (PR #104) |
| 3 — Plantilla | Empleados (lista, ficha, formulario), Áreas (árbol y ficha). El estilo de los enlaces de contenido (`linkSx`) queda en un solo sitio. | Fusionada (PR #105) |
| 4 — Mantenimiento | Planes, órdenes, talleres, «Mis órdenes» en móvil. Subida de archivos con botón propio; los formularios de alta de talleres y mecánicos pasan a `CatalogForms.tsx`. | Fusionada (PR #106) |
| 5 — Configuración y acceso | Empresa, Usuarios (invitar al lado de la lista), Roles, inicio de sesión e invitación en una tarjeta centrada con el logo (`AuthLayout`, `BrandMark`). | En curso |
| 6 — Estados | `UiState` (vacío, sin resultados, error, sin permiso) como bloques centrados con icono; diálogos y formularios. | |

M4 (siniestros) sigue en pausa por indicación del propietario; cuando se reanude, sus pantallas nacen con el tema v2.

## Regresión visual fuera del CI

El 2026-10-13 (01:13 UTC) el propietario pidió «sacar las snapshots de los targets de quality». Desde entonces:

- El workflow `quality` ya no ejecuta `pnpm test:visual` (aplicado en el PR #100, que reorganizó el CI). Las stories siguen pasando por el typecheck de `packages/ui` (incluido `.storybook`) y por el escaneo de accesibilidad de `e2e/components.spec.ts`.
- `pnpm quality` no incluía las snapshots y no cambia.
- Las capturas y los comandos `pnpm test:visual` y `pnpm test:visual:update` se conservan como herramienta local para comparar antes y después de un cambio visual.
- Esto modifica la verificación de ADR-0010 (regresión visual como gate de CI) por decisión del propietario. SPECS §9.1 sigue pidiendo regresión visual: queda cubierta de forma local, no como bloqueo del CI.

## Lo que esta decisión no hace

- No cambia contratos, permisos, datos ni flujos: solo presentación (el resumen de Alertas usa la misma lectura `alerts.list` que ya usa Inicio).
- No reduce requisitos de SPECS §8: accesibilidad, estados por texto, 360px y fuentes autoalojadas siguen igual.
- No edita SPECS.md, Orchestrator.md ni `docs/baselines`.
- No autoriza AWS ni producción.

## Consecuencias

- El piloto regenera 764 de las 768 capturas de regresión visual (todo cambia de aspecto) y añade 4 de las tarjetas de resumen; desde ahí cada fase solo regenera las suyas.
- `e2e/components.spec.ts` comprueba la escala v2 (H1 24px).
