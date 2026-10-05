# Informe de gate G0 — candidato `8b1b61c187c153c2c24e4cf3d714f8ae7f41051e`

Fecha: 2026-10-05, America/Mexico_City. Alcance: acumulativo (M0 FND-REPO/CONTRACTS/DS/AWS/ORCH/INTEGRATE más los slices M1 de audit/outbox #15, tenancy #16, auth #17, seguimientos #20, y los cierres de G0 #19, #21, #22 y #23). Sustituye al informe histórico `docs/audits/G0/2026-10-04-report.md`.

## Resultado

| Auditor                                                                              | Modelo observado  | Candidato | Veredicto | Informe                    |
| ------------------------------------------------------------------------------------ | ----------------- | --------- | --------- | -------------------------- |
| A (independiente, contexto limpio)                                                   | `claude-opus-5-5` | `8b1b61c` | APPROVE   | [`audit-a.md`](audit-a.md) |
| B (independiente, contexto limpio, otro ángulo: seguridad, orquestador, CI, pruebas) | `claude-opus-5-5` | `8b1b61c` | APPROVE   | [`audit-b.md`](audit-b.md) |

Ambos auditores ejecutaron por su cuenta install, `baseline:check`, lint, `format:check`, `tsc -b`, build, `test:unit` con umbrales, integración MySQL 8.0.45 (6/6) y Playwright chromium (9/9); `quality` está en verde en GitHub sobre este SHA. No encontraron rutas entre tenants ni bypass de autenticación en M1.

## Historial de la ronda

0. `776abce` (main tras #20): primera revisión de G0 (cambios solicitados; conclusiones recogidas en las rondas siguientes; el informe vive en el almacén del proyecto, no en el repositorio).
1. `940fbdf`: la primera revisión y dos auditores solicitaron cambios (informes en el almacén del proyecto; PR #21 y #22 los atendieron).
2. `89d3de1`: dos auditores solicitaron cambios (`previous-audit-a-89d3de1.md`, `previous-audit-b-89d3de1.md`). Bloqueos: umbrales 90/85 solo en ui, contracts y orquestador; huecos en gates del orquestador; diferimiento de FND-ORCH sin autoridad; contraste de bordes de campos (~1,7:1); `main` sin branch protection.
3. #23 cerró los bloqueos de código (gates acumulativos con dos auditores no autores sobre un mismo SHA que cubre todos los candidatos de la etapa; contraste 4,8:1; umbrales 90/85 en los 12 paquetes de producción y el orquestador). La decisión sobre FND-ORCH la tomó el usuario (ADR-0008).
4. `8b1b61c`: ambos auditores aprueban.

## Condiciones y bloqueos externos explícitos

- **Branch protection en `main`: no configurada.** Solo el propietario o un administrador de GitHub puede configurarla (check `quality` requerido, sin pushes directos). Ambos auditores la registran como criterio de FND-INTEGRATE ("protección de baseline/gates contra cambios del autor") aún no cumplido. **G0 solo debe registrarse como aprobado si el propietario la activa o acepta por escrito que G0 pasa con ella abierta.**
- **AWS: diferido (ADR-0002).** La viabilidad queda pendiente; auditor A y B lo aceptan como bloqueo externo registrado.
- **Diferimiento de FND-ORCH a G1** (GitHub fake, store/proyección de Tasks, `simulate`, e2e): decisión del usuario atestiguada en ADR-0008 (tarjeta de decisión en la app, 2026-10-05); el repositorio no puede verificarla. Fecha límite: cierre de G1.
- **Storybook como runtime y snapshots de píxeles:** diferidos a antes de la primera pantalla funcional y no más tarde de G1.
- **Excepción de M1:** #15, #16, #17 y #20 se fusionaron antes de G0 y fueron ratificados por el usuario (ADR-0008); el código M1 está dentro del alcance acumulativo auditado.
- **Autoría:** la sesión que redactó #19–#23 no declara G0 aprobado. La decisión de aprobación corresponde al usuario.

## Hallazgos no bloqueantes (a atender en G1)

- Umbral 95/90 de §9.1 para auth/identity/tenancy: se cumple por medición (p. ej. tenancy 96,2 % líneas / 95,8 % ramas) pero el CI solo exige 90/85.
- `TenantControlPlane.provision` sin comprobación de autorización propia y regla del último administrador sin aplicar (pertenece al adaptador de auth persistente); `handoff` impide que candidatos del proveedor anterior pasen un gate (tensión con ADR-0007); `requestedPaths` vacío da un lease que no bloquea nada; un titular de lease vencido o un identificador que difiere solo en mayúsculas/espacios cuenta como auditor independiente; Tabs de MUI en mayúsculas; `pnpm audit` con 3 avisos moderados; CORE-AUTH-M1 aún dice que `format:check` falla.
- Runtime del orquestador (aún sin conectar): una etapa sin gate registrado cuenta como abierta; `register` acepta `stage` no entero y tareas ya `completed`; dedupe global por `eventId`; `restore` no valida rutas de lease ni puede re-verificar evidencia; los locks de rutas ignoran globs `*`.
- Trazabilidad: la matriz de FND-CONTRACTS no incluye aún el código M1 fusionado.
- Documentación: líneas históricas de proveedor en `docs/tasks/FND-ORCH.md` y referencia a un informe 776abce que no está en el repositorio (ADR-0008) — corregidas en este mismo cambio.

## Inventario acumulativo (PR y SHA de fusión en `main`)

| PR     | Contenido                                                                                                                                                              | SHA de fusión |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| #1–#14 | Base M0 (FND-REPO/CONTRACTS/DS/AWS/ORCH/INTEGRATE, orquestador 1.2, handshake) integrada antes de esta ronda por Codex; los SHA individuales no se re-verificaron aquí | n/d           |
| #19    | ADR-0007, baseline 1.4, pines de modelo                                                                                                                                | `e8c9305`     |
| #17    | Auth e identidad                                                                                                                                                       | `cc56f1f`     |
| #15    | Outbox de auditoría                                                                                                                                                    | `72db075`     |
| #16    | Plano de control de tenancy                                                                                                                                            | `80fa641`     |
| #20    | Seguimientos M1                                                                                                                                                        | `776abce`     |
| #21    | Cierre de huecos G0 (CI, integridad de baseline, evidencia DS)                                                                                                         | `940fbdf`     |
| #22    | Escala tipográfica, e2e de teclado/360px/stories, etiquetas de trazabilidad                                                                                            | `89d3de1`     |
| #23    | Gates acumulativos, contraste de bordes, umbrales M1                                                                                                                   | `8b1b61c`     |

Auditoría de cada PR: revisión de código Opus 5.5 sobre el headSHA vigente antes de fusionar (ADR-0007); la evidencia por PR está en las conversaciones de revisión, no en el repositorio. La decisión del usuario sobre el diferimiento de FND-ORCH se tomó mediante una tarjeta de decisión en la app el 2026-10-05 (sin identificador verificable desde el repositorio).
