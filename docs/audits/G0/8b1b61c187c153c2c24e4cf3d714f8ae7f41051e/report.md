# Informe de gate G0 — candidato `8b1b61c187c153c2c24e4cf3d714f8ae7f41051e`

Fecha: 2026-10-05, America/Mexico_City. Alcance: acumulativo (M0 FND-REPO/CONTRACTS/DS/AWS/ORCH/INTEGRATE más los slices M1 de audit/outbox #15, tenancy #16, auth #17, seguimientos #20, y los cierres de G0 #19, #21, #22 y #23). Sustituye al informe histórico `docs/audits/G0/2026-10-04-report.md`.

## Resultado

| Auditor                                                                              | Modelo observado  | Candidato | Veredicto | Informe                    |
| ------------------------------------------------------------------------------------ | ----------------- | --------- | --------- | -------------------------- |
| A (independiente, contexto limpio)                                                   | `claude-opus-5-5` | `8b1b61c` | APPROVE   | [`audit-a.md`](audit-a.md) |
| B (independiente, contexto limpio, otro ángulo: seguridad, orquestador, CI, pruebas) | `claude-opus-5-5` | `8b1b61c` | APPROVE   | [`audit-b.md`](audit-b.md) |

Ambos auditores ejecutaron por su cuenta install, `baseline:check`, lint, `format:check`, `tsc -b`, build, `test:unit` con umbrales, integración MySQL 8.0.45 (6/6) y Playwright chromium (9/9); `quality` está en verde en GitHub sobre este SHA. No encontraron rutas entre tenants ni bypass de autenticación en M1.

## Historial de la ronda

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

- Umbral 95/90 de §9.1 para auth/identity/tenancy: hoy se cumple salvo funciones de `persistence-tenancy` (91 %, por `entities.ts`), pero el CI exige 90/85.
- Runtime del orquestador (aún sin conectar): una etapa sin gate registrado cuenta como abierta; `register` acepta `stage` no entero y tareas ya `completed`; dedupe global por `eventId`; `restore` no valida rutas de lease ni puede re-verificar evidencia; los locks de rutas ignoran globs `*`.
- Trazabilidad: la matriz de FND-CONTRACTS no incluye aún el código M1 fusionado.
- Documentación: líneas históricas de proveedor en `docs/tasks/FND-ORCH.md` y referencia a un informe 776abce que no está en el repositorio (ADR-0008) — corregidas en este mismo cambio.
