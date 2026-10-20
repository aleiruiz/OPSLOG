# Suite de aceptación independiente (MVP-QA-M5, etapa 1)

Paquete `docs/tasks/MVP-QA-M5-20261019.md`, etapa 1. Pruebas de aceptación **separadas de las de los autores**: usan el arnés de flota (`tests/e2e/fleet/mysql.ts` y `world.ts`: dos bases MySQL físicamente separadas, A y B, con cuentas restringidas por módulo) y el BFF real por HTTP. No tocan almacenes ni dominio; todo pasa por la superficie `/api`. Solo datos sintéticos.

## Cómo correrla

```bash
# MySQL 8.4 efímero y sintético en loopback (el de CI usa la imagen fijada de quality.yml)
docker run -d --rm -p 3306:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.4
export OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql
pnpm install --frozen-lockfile && pnpm build   # los paquetes resuelven a dist/
pnpm test:acceptance
```

- Sin `OPSLOG_TEST_MYSQL_ADMIN_URL` la suite **falla** (no se omite): una aceptación que se salta en silencio no acepta nada.
- El script usa `--allowOnly=false --retry=0`: ningún `.only`, ningún reintento que oculte inestabilidad. No hay `skip` en la suite.
- Cada archivo levanta su propio par de bases (~20 s de migraciones) y no depende del orden de los demás ni de los casos entre sí (cada caso crea sus datos con etiquetas únicas).
- Máximo 2 archivos en paralelo (`--maxWorkers=2`); en CI hace falta `max_connections` alto como en `test:integration`.
- **No está cableada en CI.** Hoy `quality.yml` ejecuta `pnpm test:integration`, que lista a mano cada suite; no hay un patrón de «suite adicional opcional» al que sumarla sin tocar `.github/workflows/quality.yml` ni la lista de `test:platform` (ambos fuera de los paths de este paquete). La etapa 2 (candidato de MVP-INTEGRATE) la ejecuta como paso explícito y registra el resultado en `docs/traceability/final.md`.
- Tampoco está en el `tsconfig.json` raíz (archivo compartido): se comprueba con `pnpm exec tsc -p tests/acceptance/tsconfig.json --noEmit`. Añadir la referencia y la carpeta al `format:check` es una línea que corresponde a quien tenga el lease de los archivos raíz.

## Contenido

| Archivo                   | Qué cubre                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `journeys-fleet.test.ts`  | SPECS §9.1: invitación, login y revocación (J1); alta de vehículo (J2); asignación simultánea (J3); documento y seguro renovados (J4); importación y exportación (J7); drill-down del dashboard (J8)                     |
| `journeys-cases.test.ts`  | SPECS §9.1: mantenimiento completo (J5); siniestro completo (J6a), rechazado (J6b) y reabierto (J6c); búsqueda con permisos (J9)                                                                                         |
| `isolation-m5.test.ts`    | SPECS §4.4 para las vías nuevas de M5: búsqueda, vistas guardadas, dashboard y su cache, reportes y jobs, descargas, notificaciones y correo del sumidero, webhooks y su historial, consulta de audit, cabeceras y roles |
| `stride-export.test.ts`   | STRIDE de la exportación: un caso negativo por amenaza                                                                                                                                                                   |
| `stride-webhooks.test.ts` | STRIDE de los webhooks, con el cliente seguro real, DNS y transporte sintéticos                                                                                                                                          |
| `stride-search.test.ts`   | STRIDE de la búsqueda                                                                                                                                                                                                    |
| `known-gaps.test.ts`      | Brechas conocidas registradas con `it.fails` (no son skips); hoy FIX-QA-1 (sin limitador de intentos de login, NFR-S8)                                                                                                   |
| `asvs.test.ts`            | Controles ASVS L2 verificables por HTTP                                                                                                                                                                                  |
| `stride.md`               | Mapa amenaza → defensa → caso                                                                                                                                                                                            |
| `asvs-l2.md`              | Checklist ASVS L2 (versión fijada 4.0.3) con lo no verificable en staging marcado                                                                                                                                        |

## Diferido a la etapa 2 (no entra en este PR)

| Parte del encargo                                                     | Por qué se difiere                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navegador sobre `e2e/real-api` (journeys en Playwright)               | `e2e/real-api/**` y `tests/e2e/mvp` los cablea MVP-INTEGRATE en paralelo (mismos archivos compartidos); se añade sobre el candidato.                                                                                                                                                                                              |
| Accesibilidad con axe en todas las pantallas de M5 y M1 a M4          | Necesita las rutas web integradas por MVP-INTEGRATE (shell, `/analisis/*`, `/configuracion/integraciones`) que no están en `main`.                                                                                                                                                                                                |
| Regresión visual de las pantallas de M5                               | Misma dependencia; M-1 de G4 sigue diferido por el propietario para las líneas base viejas.                                                                                                                                                                                                                                       |
| Mutación dirigida (ADR-0011 §3)                                       | Se probó a mano en esta etapa con tres mutantes locales, nunca fusionados: neutralización de fórmulas desactivada, guardia SSRF sin bloqueo y verificación de firma sin comparar; los casos T y D de exportación y webhooks los detectan. La PII de búsqueda no se mutó. La corrida sistemática con herramienta es de la etapa 2. |
| Cambio de permisos con trabajo pendiente (SPECS §4.4)                 | Un job de exportación asíncrono necesita más de 5.000 filas por empresa; está cubierto por `tests/integration/platform/reports-operations.test.ts` y se registra como hueco de la matriz hasta una prueba propia.                                                                                                                 |
| Límite de 60 entregas por minuto de webhooks y 20 fallos consecutivos | Cubiertos por las pruebas del autor; sin prueba independiente aún (hueco en la matriz).                                                                                                                                                                                                                                           |
