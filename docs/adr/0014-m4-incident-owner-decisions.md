# ADR-0014: decisiones del propietario para siniestros (M4)

Estado: **decisión del propietario transcrita por la sesión autora.** El repositorio no puede verificarla (la misma limitación que ADR-0008, ADR-0009 y ADR-0011): el registro es una transcripción, no una firma del propietario ni una aprobación de auditores.
Fecha de la decisión: 2026-10-13 02:20 UTC, en el hilo del proyecto.
Decisor: Alei Ruiz (propietario).

Texto literal del propietario:

> "Cuando el costo lo supera, si, comprimir, una de las 2 con correo reparalo"

Compatible con SPEC-1.4 y ORCH-1.4. No modifica `SPECS.md`, `Orchestrator.md` ni `docs/baselines/**`.

## Contexto

Los seis paquetes de M4 (`docs/tasks/INC-*-M4-20261013.md`) dejaron cinco preguntas abiertas para el propietario. Cada respuesta corta corresponde, en orden, a una pregunta:

1. "Cuando el costo lo supera": cierre costoso D20.
2. "si": permisos propios del módulo de siniestros.
3. "comprimir": compresión de fotos en el navegador.
4. "una de las 2": requisito de `repair`.
5. "con correo": canal de los avisos de siniestros.

La palabra final ("reparalo") puede leerse como parte de la respuesta sobre reparación o como la instrucción de corregir los paquetes. Las dos lecturas llevan al mismo resultado. La correspondencia entre respuesta y pregunta es una interpretación de la sesión autora. Si el propietario la corrige, un ADR posterior sustituye a este.

Estas decisiones concretan defaults de `SPECS.md` §2.3 (D10, D16, D18, D20), §6.2 y §7. No son una baseline nueva. Donde una decisión se aparta del texto literal de SPECS, se dice abajo.

## Decisión

### 1. D20: aprobación solo cuando el costo supera el umbral

SPECS D20 dice: "Umbral opcional por empresa; si se configura, exige supervisor con incidents:approve antes de cerrar". Los paquetes lo leían como en M3: con umbral, todo cierre pide aprobación sin comparar montos. El BRD (BR-028, US-051) compara el costo con el umbral. El propietario eligió comparar.

Regla para siniestros:

- El monto comparado es el costo a cargo de la empresa (`companyBorne` de INC-COSTS: reparaciones + gastos − recuperaciones), por moneda, leído en la misma transacción del comando.
- Se exige aprobación de un miembro con `incidents:approve` si y solo si hay umbral configurado y el costo **supera** el umbral (`companyBorne > umbral`, comparación estricta en unidad mínima). Igual al umbral no exige aprobación.
- Moneda distinta: no hay conversión de moneda en el MVP. Si existe un costo a cargo de la empresa mayor que cero en una moneda distinta de la del umbral, se exige aprobación, porque no se puede probar que no lo supera.
- Si la configuración o los totales de costos no se pueden leer, el comando falla (500). Nunca se trata como "no supera".
- La misma comparación aplica a la asunción de costo tras rechazo de la aseguradora, con los costos registrados en ese momento. El cierre vuelve a comparar con los costos finales, así que un costo que crece después de la asunción exige aprobación al cerrar.
- Las aprobaciones se siguen borrando al cambiar costos, vínculos o resolución, al apelar y al reabrir.

Mantenimiento: M3 hoy pide aprobación en todo cierre de orden cuando hay umbral (G3, `docs/traceability/maintenance.md`). La respuesta del propietario aplica también a mantenimiento. Alinear las órdenes de trabajo es una **tarea de seguimiento** separada que debe crear el coordinador; no se hace en este cambio ni en los paquetes de M4.

### 2. Permisos propios del módulo de siniestros

SPECS D10 dice "siniestros requieren permiso separado" y la matriz BRD §6.3 deja al responsable de flotilla solo con consulta en siniestros. Con los verbos genéricos, un editor de flota con `edit` gestionaría casos. El propietario decidió que siniestros tenga permisos propios.

Catálogo de siniestros:

| Permiso                | Concede                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `incidents:view`       | Leer lista, detalle, timeline, terceros (sin identidad) y evidencia       |
| `incidents:create`     | Crear borradores de cualquier caso                                        |
| `incidents:edit`       | Editar casos, terceros y evidencia, y ejecutar los comandos de gestión    |
| `incidents:report`     | D8: crear, editar, reportar y cancelar solo los borradores propios        |
| `incidents:approve`    | D20: aprobar cierre o asunción cuando el costo supera el umbral           |
| `incidents:close`      | Cerrar un caso resuelto                                                   |
| `incidents:reopen`     | Reabrir un caso cerrado                                                   |
| `incidents:view_costs` | Ver costos, totales y snapshots de siniestros (separado de mantenimiento) |

- Los verbos genéricos `view`, `create` y `edit` ya no conceden nada en siniestros. `view_pii` sigue siendo genérico y, junto con `incidents:view`, muestra la identidad de terceros.
- Plantillas sintéticas de la composición: `admin` recibe todos; `editor` y `viewer` reciben solo `incidents:view` (la flotilla consulta); se añade la plantilla `incident_manager` con `view`, `incidents:view`, `incidents:create`, `incidents:edit`, `incidents:report`, `incidents:close` e `incidents:view_costs`. El catálogo real de siete plantillas de SPECS §5.4 sigue siendo del paquete de roles.
- No existe `override_workflow` ni permiso de bypass (D16).

### 3. Fotos comprimidas en el navegador

US-030 pide comprimir en el navegador a unos 2 MB. D18 pide preservar originales privados con SHA-256 y derivados para vista, sin sobrescribir. El propietario eligió comprimir.

- La web comprime las fotos (JPEG, PNG, WebP) a unos 2 MB antes de subir. PDF, DOCX y XLSX no se tocan. Si la compresión falla, se sube el archivo sin comprimir dentro de los límites de SPECS §7.
- El archivo que llega al servidor es el **original preservado**: se guarda íntegro, privado y con su SHA-256. El servidor sigue generando derivados de vista (≤ 2000 px). Nada se sobrescribe.
- Tensión honesta: los bytes de la cámara nunca llegan al servidor. La foto preservada ya perdió resolución y, normalmente, metadatos EXIF. D18 se cumple sobre el archivo recibido, no sobre la captura del dispositivo. La evidencia registra que el cliente declaró haberla comprimido. Este dato es informativo, no una prueba.

### 4. `repair` exige orden o presupuesto

SPECS §6.2 escribe "orden/presupuesto" en la regla general y el BRD pedía ambos. El propietario eligió "una de las 2": `repair` exige una orden correctiva vinculada **o** un presupuesto (evidencia `budget` en estado `clean`), no ambos.

Se aplica a todos los orígenes de `repair`. La fila `insurance_process → repair` de SPECS §6.2 dice literalmente "orden correctiva y presupuesto". Este punto se aparta de ese texto por adopción expresa del propietario. Si el propietario quería mantener ambos en esa fila, un ADR posterior lo corrige.

Sin orden vinculada, el costo de la reparación se registra como línea propia del siniestro, y la evidencia final sigue siendo obligatoria para resolver.

### 5. Avisos de siniestros también por correo

Los avisos de siniestros (asignación, SLA, sin responsable, inactividad y escalaciones) se envían in-app y por correo. Los avisos in-app se mantienen.

- AWS sigue diferido (ADR-0002) y la etapa 0 no tiene SES (ADR-0012). El correo sale por un **puerto de correo**. Fuera de producción lo implementa un sumidero de prueba que registra el mensaje sin enviarlo. El envío real se conecta cuando se active AWS.
- El correo de siniestros es obligatorio en M4: no hay preferencia para silenciarlo. El centro de preferencias y las plantillas configurables siguen en MVP-NOTIFY.
- El envío es asíncrono desde el outbox, idempotente por aviso, destinatario y canal, y un fallo de correo no revierte la operación (SPECS §7). Los destinatarios y permisos se revalidan al enviar. El contenido es mínimo: folio, tipo de aviso y enlace, sin importes, PII ni texto libre.

## Consecuencias

- Los seis paquetes de M4 se actualizan en el mismo cambio que este ADR. Las cinco preguntas salen de sus listas de pendientes y quedan como decisiones del propietario con referencia a este ADR.
- INC-WORKFLOW necesita los totales de costo de INC-COSTS para D20. Sin INC-COSTS, la comparación falla cerrada: con umbral, se exige aprobación.
- INC-SLA crea el puerto de correo y el sumidero de prueba dentro de sus paths. MVP-NOTIFY generaliza después el puerto, las plantillas y las preferencias.
- Queda una tarea de seguimiento para alinear D20 en mantenimiento.
- No cambian: `SPECS.md`, `Orchestrator.md`, las baselines, D16 (sin override), AWS diferido, producción sin autorización, proveedor único y la auditoría independiente por PR.
- Este ADR no declara ningún gate aprobado. G4 sigue pendiente de su auditoría y de la aceptación del propietario.
