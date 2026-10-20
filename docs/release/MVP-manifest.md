# Manifiesto del candidato MVP (M5)

Paquete `MVP-INTEGRATE-M5-20261019`, PR 2. Congela lo que se conoce del candidato para G5 y deja explícito lo que **no** se conoce. Este documento no declara G5 aprobado ni autoriza producción: ver «Pendientes de lanzamiento».

Regla de lectura: una celda que dice **pendiente** no está aprobada ni medida; su condición dice qué la cierra.

## 1. Candidato

| Dato                         | Valor                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA del candidato            | **pendiente: SHA de fusión** de este PR en `main` (el candidato es `main` después de fusionarlo; se anota aquí al fusionar y es el que ve G5)                                                                       |
| Base conocida al redactar    | `c64881e` (PR 1 de este paquete, #148) sobre `ca2ee13` (suite de aceptación, #147)                                                                                                                                  |
| Baseline                     | SPEC-1.4 y ORCH-1.4, con las originales no sustituidas; sin cambios en `SPECS.md`, `Orchestrator.md` ni `docs/baselines/**`                                                                                         |
| Alcance                      | ADR-0016 (etapa 0: pila Docker Compose con MySQL 8.4 en un VPS, una empresa por despliegue, AWS diferido)                                                                                                           |
| Despliegue de demo (Coolify) | **pendiente**: no se desplegó desde este paquete. Condición: que el propietario siga `docs/operations/DEPLOY_COOLIFY.md` y `docs/runbooks/release-rollback-coolify.md` con respaldo previo y registre aquí la fecha |

## 2. Imágenes

El entorno de redacción no tiene Docker; ninguna imagen se construyó ni se resolvió su digest. **Los digest quedan pendientes.**

| Imagen                       | Origen (`deploy/Dockerfile`, destino) | Base declarada          | Digest                                                                                |
| ---------------------------- | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `api` (también `migrate`)    | `api`                                 | `node:22-bookworm-slim` | **pendiente**: se resuelve al construir en Coolify o en el CI de lanzamiento          |
| `web`                        | `web`                                 | `nginx:1.27-alpine`     | **pendiente**: igual                                                                  |
| `backup`                     | `backup`                              | `mysql:8.4`             | **pendiente**: igual; la imagen no se ha construido en ningún entorno de este paquete |
| `landing`                    | `landing`                             | `node:22-bookworm-slim` | **pendiente**: igual                                                                  |
| `mysql` (servicio del stack) | imagen publicada                      | `mysql:8.4` (compose)   | **pendiente** en el compose: la etiqueta no fija digest. El CI sí lo fija (ver abajo) |
| `k6` (carga)                 | imagen publicada                      | `grafana/k6:1.0.0`      | **pendiente**: el digest no se fijó y k6 no se ha ejecutado nunca (ver «Carga»)       |

Condición para cerrar: construir las imágenes del SHA candidato, registrar cada `sha256` aquí y fijar las bases por digest en `deploy/Dockerfile` y `docker-compose.yml` (cambio de despliegue que no hace este PR).

## 3. Versiones exactas

| Componente              | Versión                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL en el CI          | **8.4.11**, imagen `mirror.gcr.io/library/mysql:8.4.11@sha256:80f4933e3835f9dc4d35a28ec500d7986cb4414e6c6821c5461239cb7beb8995` (`.github/workflows/quality.yml`) |
| MySQL del stack         | `mysql:8.4` (etiqueta móvil en `docker-compose.yml`; la versión menor exacta de la demo es **pendiente** hasta desplegarla)                                       |
| MySQL de las mediciones | 8.0.46 local (simulacro y carga de MVP-OPS; ver §5). **No** se midió en 8.4                                                                                       |
| Node                    | `>=22.13.0` (`engines`); imágenes `node:22-bookworm-slim`; mediciones con 22.22.0                                                                                 |
| pnpm                    | 11.25.0 (`packageManager`)                                                                                                                                        |
| TypeScript              | 5.8.3                                                                                                                                                             |
| Vitest / Playwright     | 3.2.6 / 1.56.1                                                                                                                                                    |
| Vite / React / MUI      | 6.4.4 / 19.1.0 / 6.4.12                                                                                                                                           |
| TypeORM / mysql2        | 1.1.1 / 3.22.0                                                                                                                                                    |
| Dependencias nuevas M5  | `exceljs` 4.4.0 (XLSX), `pdfkit` 0.20.2 (PDF), `nodemailer` 10.0.14 (SMTP opcional); versión exacta fijada en `package.json` y `pnpm-lock.yaml`                   |

## 4. Suites

Cada fila se lee del flujo `quality` en GitHub, que es lo único que cuenta como evidencia de CI. El detalle de conteos de pruebas no está en este documento: los registros del CI no se pudieron leer desde el entorno de redacción, así que aquí solo consta el resultado del job.

| Suite                                                                                                      | Dónde corre                            | Último resultado en `main` conocido al redactar                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm baseline:check`, `leak:scan`, `lint`, `format:check`, `typecheck`, `build`                           | job `static`                           | éxito en `ca2ee13` (3 min 15 s)                                                                                                                                                                 |
| `pnpm test:unit`                                                                                           | job `unit`                             | éxito en `ca2ee13` (10 min 32 s)                                                                                                                                                                |
| `pnpm test:integration` (incluye `test:platform`, ahora también `tests/e2e/mvp` y `tests/integration/mvp`) | job `integration`, MySQL 8.4.11        | éxito en `ca2ee13` (8 min 12 s, **antes** de sumar las dos carpetas); la corrida con ellas es la de este PR                                                                                     |
| `pnpm test:e2e` (Playwright, incluye `e2e/mvp-journeys.spec.ts`)                                           | job `e2e`, MySQL 8.4.11                | éxito en `ca2ee13` (13 min 15 s, **antes** del journey nuevo); la corrida con él es la de este PR                                                                                               |
| `pnpm test:fleet-integration`                                                                              | local (alias de las carpetas de flota) | no corre en el CI; las mismas carpetas entran por `test:platform`                                                                                                                               |
| `pnpm test:acceptance`                                                                                     | local; no está en el CI                | **pendiente** en el CI. No tiene resultado de CI; se corre a mano con MySQL 8.4 (ver `tests/acceptance/README.md`). Se deja fuera del CI por duración (cada archivo migra dos bases, unos 20 s) |
| `pnpm ops:drill` / `pnpm ops:load`                                                                         | local; no corren en el CI ordinario    | medidos en MVP-OPS con MySQL 8.0.46 (§5); **no** repetidos sobre el candidato                                                                                                                   |
| `pnpm test:visual`                                                                                         | fuera del CI                           | según la decisión del propietario sobre M-1 de G4; **no** es puerta                                                                                                                             |

Estado de `main` al redactar: la corrida de `c64881e` (fusión de #148) terminó en verde; las duraciones de la fila de arriba son las de `ca2ee13`. Los escenarios MySQL de las suites solo se omiten sin `OPSLOG_TEST_MYSQL_ADMIN_URL`; en el CI la variable existe y las suites de este paquete no se omiten.

Validación local de este PR (MySQL 8.0 en loopback, no 8.4): `tests/integration/mvp` 13 pruebas, `e2e/mvp-journeys.spec.ts` 3 pruebas, ambas en verde; `pnpm typecheck` sin errores. Las cifras de la ejecución en MySQL 8.4 las da el CI de este PR.

## 5. Rendimiento y recuperación (MVP-OPS)

Cifras tomadas de `docs/tasks/MVP-OPS-M5-20261019.md` y `docs/operations/SEARCH_PERFORMANCE.md`. Máquina de 4 vCPU, MySQL **8.0.46**, generador **controlador Node** (sin k6 ni Docker). No son una validación de producción ni de la pila objetivo (VPS de 2 vCPU y 8 GB, MySQL 8.4).

| Medida                                                               | Objetivo (SPECS §9.3) | Medido                                                                          | Estado                                                                                                        |
| -------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RPO del simulacro (3 corridas)                                       | ≤ 15 min              | 4,4 s de ventana sin copiar; RPO real por diseño ≤ 900 s más el tiempo de copia | Medido solo en simulacro. **Pendiente** repetirlo en MySQL 8.4 y con el volumen real                          |
| RTO del simulacro (3 corridas, ~200 MB)                              | ≤ 4 h                 | 9,1 a 9,2 s                                                                     | Medido solo con datos sintéticos en el mismo anfitrión. **Pendiente**: no se extrapola a producción           |
| Lista de vehículos, p95, 50 usuarios                                 | 500 ms                | 123,9 ms (corrida A)                                                            | Medido                                                                                                        |
| Detalle, p95, 50 usuarios                                            | 500 ms                | 73,0 ms                                                                         | Medido                                                                                                        |
| Alta de vehículo, p95, 50 usuarios                                   | 800 ms                | 95,2 ms                                                                         | Medido                                                                                                        |
| Dashboard, p95, 50 usuarios                                          | 1000 ms               | 51,3 ms                                                                         | Medido                                                                                                        |
| Exportación pequeña, p95, 50 usuarios                                | 10 000 ms             | 312,9 ms                                                                        | Medido                                                                                                        |
| Búsqueda (prefijo / «contiene»), p95, 50 usuarios, 100.000 entidades | 700 ms                | 314,3 y 318,7 ms / 324,5 y 302,4 ms (dos corridas, tras `MVP-SEARCH-PERF`)      | Medido con 100.000 entidades                                                                                  |
| Búsqueda con 1 M de registros                                        | 700 ms                | no medida                                                                       | **Pendiente**: paso manual de `SEARCH_PERFORMANCE.md`; condición: registrar la corrida con SHA y MySQL exacto |
| Guion k6 con imagen fijada                                           | k6                    | no ejecutado                                                                    | **Pendiente**: condición: ejecutar `scenarios.js` con `grafana/k6` fijado por digest                          |
| 20 empresas, 500 sesiones, 100.000 registros por empresa             | SPECS §9.3            | no medido                                                                       | **Pendiente**: paso de la cuenta del cliente                                                                  |
| NFR-P3 (10 MB en 4G)                                                 | NFR-P3                | no medido                                                                       | **Pendiente**                                                                                                 |
| NFR-P5 (degradación ≤ 20 % frente a 1 usuario)                       | NFR-P5                | informado por escenario, no cumplido en búsqueda                                | **No declarado cumplido** (ver MVP-OPS, conclusiones)                                                         |

## 6. Pendientes de lanzamiento (ADR-0016)

Ninguno cuenta como implementado ni aprobado. G5 los revisa y los deja explícitos.

| Pendiente                                          | Origen                  | Condición para cerrarlo                                                                                                                                             |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PITR y retención de 35 días en RDS                 | ADR-0016 §3             | Cuenta AWS del cliente aprobada y base gestionada creada con `infra/terraform`. Hoy: volcado diario y binlogs en un volumen del VPS                                 |
| Copia en otra región                               | ADR-0016 §3             | Cuenta del cliente y región elegida (`docs/runbooks/customer-aws.md`)                                                                                               |
| Multi-AZ                                           | ADR-0016 §3             | Cuenta del cliente                                                                                                                                                  |
| Alarmas de CloudWatch y AWS Budgets (50/80/100 %)  | ADR-0016 §3             | Cuenta del cliente; no existen en `infra/terraform`                                                                                                                 |
| SQS / EventBridge                                  | ADR-0016 §3             | Cuenta del cliente. Hoy el outbox y el worker corren en el proceso `api`                                                                                            |
| SES (correo real a usuarios finales)               | ADR-0016 §2–3           | Cuenta del cliente. Hoy: sumidero por defecto y SMTP opcional (`OPSLOG_SMTP_*`) apagado hasta que el propietario cargue un proveedor                                |
| Despliegue sin caída (NFR-A2)                      | ADR-0016 §3             | Más de una réplica de `api` o balanceo: hoy una sola réplica, con corte breve en cada despliegue                                                                    |
| SLO de disponibilidad 99,5 % (NFR-A1)              | ADR-0016 §3             | Monitoreo y medición en la cuenta del cliente durante un periodo definido                                                                                           |
| Diff de auditoría completo (FR-171)                | ADR-0016, pregunta 1    | Decisión del propietario sobre un almacén de diffs enmascarados. Hoy parcial: nombres de campos y valores solo donde el historial ya los guarda sin PII ni importes |
| Logo de la empresa en PDF y correo                 | ADR-0016, pregunta 3    | Fuera de M5; requiere carga de logo                                                                                                                                 |
| Despliegue de la demo y recorrido con Cognito real | MVP-INTEGRATE alcance 6 | El propietario despliega en Coolify con datos sintéticos y registra `readyz` verde, inicio de sesión y un recorrido                                                 |
| Digest de imágenes y SHA del candidato             | §1 y §2                 | Ver arriba                                                                                                                                                          |
| Auditoría de seguridad y funcional G5              | `G5-AUDIT`              | Documento aparte; este manifiesto no la sustituye                                                                                                                   |

## 7. Brechas conocidas

- **FIX-QA-1:** no hay limitador de intentos de inicio de sesión (NFR-S8); la prueba lo fija en `tests/acceptance/known-gaps.test.ts`.
- **Cifrado de datos personales:** el KMS es el local de desarrollo y se niega a arrancar en producción (`DEPLOY_COOLIFY.md`).
- **Archivos:** en memoria salvo `OPSLOG_OBJECT_STORAGE=s3`, cuyo adaptador no se ha probado contra AWS real.
- **Roles de la interfaz:** un rol de plantilla sin etiqueta en `ROLE_LABELS` hace fallar el avatar del shell web (`initials` recibe `undefined`). No afecta a los seis roles reales; lo encontró el journey de navegador al usar roles sintéticos y se contorna registrando la etiqueta en la prueba.

## 8. Cómo repetir la evidencia

```text
pnpm quality
pnpm test:integration
pnpm test:fleet-integration
pnpm test:e2e
pnpm test:acceptance
pnpm ops:drill
pnpm ops:load
```
