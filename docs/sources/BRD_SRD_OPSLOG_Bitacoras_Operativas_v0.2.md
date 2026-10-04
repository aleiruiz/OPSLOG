# BRD + SRD — Plataforma B2B de Bitácoras Operativas (nombre provisional: **OPSLOG**)

| Campo | Valor |
|---|---|
| Versión | 0.2 — borrador para revisión de stakeholders (versión autocontenida, sin contexto del emisor) |
| Fecha | 2026-10-04 |
| Autor | Product Development (PM / BA / Solution Architect) |
| Estado | En revisión — contiene decisiones pendientes marcadas |
| Audiencia | Dirección, Operaciones, Producto, UX/UI, Arquitectura, Frontend, Backend, Mobile, QA, DevOps, Seguridad, Data/BI |

## Cómo leer este documento

Cada afirmación relevante lleva una etiqueta que indica su grado de certeza:

| Etiqueta | Significado |
|---|---|
| **[CONFIRMED]** | Requerimiento provisto explícitamente en el brief del producto. |
| **[PROPOSED]** | Recomendación del equipo de Product Development basada en buenas prácticas. No está confirmada por el negocio. |
| **[ASSUMPTION]** | Supuesto adoptado para poder avanzar. Debe validarse; si resulta falso, afecta el diseño. |
| **[DECISION REQUIRED]** | Decisión que debe tomar el negocio antes de diseño detallado o desarrollo, porque cambia arquitectura, UX o comportamiento. |
| **[DEPENDENCY]** | Dependencia interna o externa. |
| **[RISK]** | Riesgo identificado con su mitigación sugerida. |

Las etiquetas se aplican a nivel de sección, tabla o fila según corresponda. Cuando una tabla completa es [PROPOSED], se indica en su encabezado y no se repite por fila.

**Nota terminológica.** El brief usa vocabulario operativo de México (placas, número económico, tarjeta de circulación, refacciones). El brief no define los mercados objetivo; dado que el producto se comercializará a distintas empresas, el documento conserva esos términos como etiqueta por defecto y propone que las etiquetas de campos sean configurables por empresa (ver §7.2 y §8).

**Contexto del emisor.** Este documento se elaboró únicamente a partir del brief del producto. No asume nada sobre la empresa que lo impulsa (si opera flota propia, si ya tiene un sistema de despacho, en qué países actúa). Donde ese contexto cambiaría una decisión, se marca como [DECISION REQUIRED].

---

# PARTE A — BRD (Business Requirements Document)

## 1. EXECUTIVE SUMMARY

### 1.1 Nombre provisional
**OPSLOG — Bitácora Operativa de Flotilla y Personal.** [PROPOSED] Nombre de trabajo; el nombre comercial se define con marketing. [DECISION REQUIRED]

### 1.2 Descripción ejecutiva
OPSLOG es una plataforma web B2B, multi-empresa (multi-tenant), que centraliza la información y los procesos de gestión operativa que rodean a una operación de transporte pero que los sistemas de despacho no cubren: plantilla operativa (conductores, despachadores, áreas), vehículos, documentación y seguros, mantenimiento, mecánicos y talleres, siniestros con workflow, evidencias, historial, reportería y trazabilidad. [CONFIRMED]

Se concibe como **complemento** del sistema de despacho existente de cada cliente, no como reemplazo. Funciona de forma autónoma y puede integrarse con sistemas externos mediante API, archivos o webhooks. [CONFIRMED]

### 1.3 Problema que resuelve
Las empresas con flota y personal operativo gestionan hoy esta información en planillas, carpetas compartidas, chats y memoria de personas clave. El sistema de despacho sabe qué viaje hizo qué vehículo, pero no sabe si el seguro estaba vigente, si el conductor tenía licencia válida, cuándo fue el último servicio ni en qué estado está el siniestro del mes pasado. El resultado es falta de trazabilidad, vencimientos no detectados, vehículos operando sin cobertura, siniestros sin seguimiento y reportes armados a mano. [CONFIRMED — descripción del brief; ver §3 para detalle]

### 1.4 Oportunidad de negocio
- Mercado objetivo: empresas que ya tienen despacho resuelto (propio o de terceros) y carecen de una capa de gestión administrativa-operativa especializada. [CONFIRMED]
- La solución no compite con el despacho, por lo que no obliga al cliente a migrar su operación: baja la fricción de adopción. [PROPOSED]
- Modelo comercial SaaS por empresa, escalable por número de vehículos / usuarios. [ASSUMPTION — modelo de pricing no definido] [DECISION REQUIRED]

### 1.5 Usuarios objetivo
Administradores de empresa, responsables de flotilla, despachadores, responsables de siniestros, mecánicos, supervisores/gerentes y usuarios de consulta. [CONFIRMED] Ver §5.

### 1.6 Empresas objetivo
Empresas con flotilla propia o tercerizada, conductores internos o contratados, en transporte corporativo, transporte de personal, logística, servicios industriales y operaciones con vehículos asignados. [CONFIRMED] Ver §4.

### 1.7 Propuesta de valor
1. **Una sola fuente de verdad** para vehículos, personas, documentos, mantenimientos y siniestros.
2. **Anticipación**: alertas de vencimientos (seguros, documentos, licencias, mantenimientos) antes de que generen un problema operativo o legal.
3. **Trazabilidad completa**: quién hizo qué, cuándo, con qué evidencia; historial por vehículo y por conductor.
4. **Siniestros bajo control**: workflow con estados, responsables, evidencias y SLA.
5. **Reportes sin planillas**: exportables, filtrables, por empresa.
6. **Convive con el despacho existente**: integración opcional, no obligatoria.

### 1.8 Alcance general
Dentro del alcance del producto (no necesariamente del MVP; ver §26):
- Gestión multi-empresa con aislamiento de datos.
- Usuarios, roles y permisos configurables por empresa.
- Plantilla operativa: conductores, despachadores, áreas.
- Vehículos: datos, documentación, fotografías, seguros, mecánico asociado, historial.
- Mantenimiento preventivo y correctivo con workflow y alertas.
- Siniestros/incidentes con workflow completo, terceros, costos, evidencias.
- Gestión de documentos y evidencias con metadata, versionado y auditoría.
- Dashboard, reportes y exportaciones (CSV, Excel, PDF).
- Búsqueda, filtros y notificaciones.
- Audit trail.
- API y mecanismos de integración.

### 1.9 Qué NO pretende resolver
- **Despacho de viajes**: asignación de servicios, ruteo, tracking en tiempo real, tarifas, facturación de viajes. [CONFIRMED]
- Nómina / liquidación de sueldos de conductores. [PROPOSED — fuera de alcance]
- Contabilidad general y facturación al cliente final. [PROPOSED — fuera de alcance; los costos de mantenimiento y siniestros se registran, no se contabilizan]
- Telemetría / GPS / OBD de vehículos (podría integrarse a futuro). [PROPOSED — fuera de alcance MVP]
- Gestión de combustible. [DECISION REQUIRED — no mencionado en el brief; frecuente en este tipo de producto]
- Gestión de la relación con la aseguradora desde el lado de la aseguradora (portal de aseguradora). [PROPOSED — fuera de alcance]

### 1.10 Relación con el sistema de despacho existente
- OPSLOG **no reemplaza** el despacho. [CONFIRMED]
- Opera **de forma independiente**; la integración es opcional por cliente. [CONFIRMED]
- Integraciones posibles: API REST, importación/exportación de archivos, webhooks. [CONFIRMED] Detalle en §18.
- Objetos que tiene sentido sincronizar: catálogo de vehículos, catálogo de conductores, estado de disponibilidad (fuera de servicio / activo), y referencias de viaje al registrar un siniestro. [PROPOSED]
- [ASSUMPTION] Cada cliente tendrá un sistema de despacho distinto (propio o de terceros), por lo que la capa de integración debe ser genérica (conectores + API pública) y no acoplada a ningún despacho en particular. [DECISION REQUIRED] ¿Existe un sistema de despacho de referencia con el que se construirá la primera integración?
- [DECISION REQUIRED] ¿Quién es el "dueño" del catálogo de vehículos y conductores cuando hay integración: OPSLOG o el despacho? Esto define dirección de sincronización y resolución de conflictos (ver §18).

---

## 2. PRODUCT VISION

### 2.1 Product Vision
Ser la capa de gestión operativa y de cumplimiento que toda empresa con flota y personal operativo utiliza junto a su sistema de despacho, de modo que ningún vehículo circule sin documentación, seguro ni mantenimiento al día, y ningún siniestro quede sin seguimiento. [PROPOSED]

### 2.2 Product Mission
Centralizar, trazar y anticipar todo lo que ocurre con los vehículos y las personas de una operación de transporte, con una plataforma configurable que se adapta a cada empresa sin obligarla a cambiar su sistema de despacho. [PROPOSED]

### 2.3 Objetivos estratégicos [PROPOSED]
| ID | Objetivo |
|---|---|
| OE-1 | Construir un producto comercializable a múltiples empresas desde el día uno (multi-tenant, configurable). |
| OE-2 | Posicionarse como complemento y no como competidor de los sistemas de despacho. |
| OE-3 | Ser la fuente de verdad de cumplimiento documental y de seguros de la flota. |
| OE-4 | Habilitar un ecosistema de integraciones (despacho, aseguradoras, talleres, telemetría) a mediano plazo. |

### 2.4 Objetivos operativos [PROPOSED]
| ID | Objetivo |
|---|---|
| OO-1 | Eliminar vencimientos no detectados de seguros, documentos y licencias. |
| OO-2 | Reducir el tiempo de gestión y cierre de siniestros mediante workflow y SLA. |
| OO-3 | Garantizar que todo mantenimiento quede registrado con responsable, costo y evidencia. |
| OO-4 | Dar a despachadores y supervisores visibilidad inmediata del estado real de vehículos y conductores. |

### 2.5 Objetivos de negocio [PROPOSED]
| ID | Objetivo |
|---|---|
| ON-1 | Reducir costos por multas, siniestros sin cobertura y paradas no planificadas. |
| ON-2 | Reducir horas-persona dedicadas a armar reportes manuales. |
| ON-3 | Generar ingresos recurrentes por suscripción (SaaS). [ASSUMPTION — modelo comercial] |
| ON-4 | Mejorar la posición ante auditorías de clientes corporativos y aseguradoras (evidencia disponible). |

### 2.6 Indicadores potenciales de éxito (KPIs)
Todos los KPIs de esta tabla son **[PROPOSED]**. Ninguno es obligatorio; el negocio debe seleccionar un conjunto inicial. [DECISION REQUIRED]

| KPI | Definición propuesta | Fuente de datos | Módulo |
|---|---|---|---|
| Tiempo de gestión de siniestros | Días desde `Reported` hasta `Closed`, mediana y p90 | Timeline de estados | Siniestros |
| Tiempo de resolución de siniestros | Días desde `Reported` hasta `Resolved` | Timeline de estados | Siniestros |
| Siniestros abiertos / cerrados por período | Conteo por estado y mes | Incident | Siniestros |
| Incidentes por vehículo | Siniestros / vehículo activo / período | Incident, Vehicle | Siniestros |
| Incidentes por conductor | Siniestros / conductor activo / período | Incident, Driver | Siniestros |
| Disponibilidad de vehículos | % de vehículos en estado `Activo` sobre total de flota, promedio diario | Vehicle status history | Vehículos |
| Utilización de vehículos | Requiere datos de viajes del despacho [DEPENDENCY — integración] | Integración | Vehículos |
| Cumplimiento de mantenimiento | % de mantenimientos preventivos realizados dentro de la ventana planificada | Maintenance | Mantenimiento |
| Costo de mantenimiento | Costo total / vehículo / período; costo por km si hay kilometraje | Maintenance | Mantenimiento |
| % documentación vigente | Documentos vigentes / documentos obligatorios × 100, por vehículo y por conductor | VehicleDocument, DriverDocument | Documentos |
| % seguros vigentes | Vehículos con póliza vigente / vehículos activos | InsurancePolicy | Seguros |
| Tiempo medio de respuesta a alertas | Desde emisión de alerta hasta acción asociada (renovación, programación) | Notification, Audit | Notificaciones |

---

## 3. PROBLEM STATEMENT

### 3.1 Situación actual [CONFIRMED en lo esencial; ejemplos marcados]
Las empresas objetivo ya operan con un sistema de despacho que resuelve la asignación y ejecución de viajes. Todo lo demás —quién es el conductor, qué vehículo tiene asignado, si su licencia está vigente, si el vehículo tiene seguro, cuándo le toca servicio, qué pasó en el siniestro del martes— vive fuera de ese sistema: planillas, carpetas de documentos escaneados, grupos de mensajería, correos con la aseguradora y conocimiento tácito de una o dos personas. [CONFIRMED]

### 3.2 Problemas identificados

| # | Problema | Consecuencia | Cómo lo resuelve OPSLOG |
|---|---|---|---|
| P1 | **Información dispersa** en planillas, carpetas, chats y sistemas no integrados. | No hay una respuesta única a "¿cuál es el estado real de este vehículo?". | Ficha única por vehículo y por conductor con todo asociado (documentos, seguros, mantenimientos, siniestros, historial). |
| P2 | **Procesos manuales**: renovaciones, programación de servicios, seguimiento de siniestros. | Dependencia de personas; errores y omisiones. | Alertas automáticas, workflows con estados y responsables. |
| P3 | **Falta de trazabilidad**: no se sabe quién cambió qué ni cuándo. | Conflictos internos, imposibilidad de auditar. | Audit trail, historial por entidad, versionado de documentos. |
| P4 | **Falta de visibilidad** para dirección y supervisores. | Decisiones sin datos; sorpresas. | Dashboard, reportes, indicadores. |
| P5 | **Riesgo operativo**: vehículos circulan sin seguro, sin documentación o con mantenimiento vencido. | Multas, inmovilización, accidentes sin cobertura. | Alertas de vencimiento, reglas de "fuera de servicio", visibilidad para despacho. |
| P6 | **Riesgo administrativo / legal**: licencias vencidas, documentación de empleados incompleta. | Responsabilidad legal de la empresa. | Vencimientos de licencias y documentos de conductores. |
| P7 | **Mantenimiento reactivo**: no hay plan preventivo, no se registra costo ni evidencia. | Costos elevados, paradas no planificadas, sin historial para reclamos de garantía. | Módulo de mantenimiento con planes por fecha/km, costos, refacciones, facturas, evidencias. |
| P8 | **Documentación sin control**: versiones, fechas de expiración, quién la cargó. | Documentos vencidos en uso; duplicados. | Gestión documental con metadata, expiración, versiones y permisos. |
| P9 | **Siniestros sin proceso**: cada caso se gestiona distinto; evidencia perdida; sin seguimiento con la aseguradora. | Reclamos rechazados, costos asumidos, cierres sin resolución. | Workflow de siniestros con estados, evidencias requeridas, aseguradora, ajustador, costos, SLA. |
| P10 | **Reportería manual**: reportes armados en planillas cada mes. | Horas perdidas, datos inconsistentes. | Reportes parametrizables y exportables. |

### 3.3 Escenarios actuales vs. con OPSLOG [PROPOSED — ejemplos ilustrativos]

**Escenario A — Seguro vencido.**
*Hoy:* la póliza del vehículo 042 venció hace 11 días. Nadie lo notó porque la planilla de seguros la actualiza una persona que está de vacaciones. El vehículo sigue operando. Ocurre un siniestro menor; la aseguradora rechaza.
*Con OPSLOG:* 30, 15 y 7 días antes del vencimiento el responsable de flotilla recibe alertas in-app y por correo. El dashboard muestra "Seguros por vencer: 3". Si la empresa configura la regla, el vehículo pasa automáticamente a "Restringido" al vencer y el despachador lo ve en su consulta.

**Escenario B — Siniestro sin seguimiento.**
*Hoy:* un conductor choca. Envía fotos por chat al supervisor. El supervisor llama a la aseguradora. Tres semanas después nadie sabe si el ajustador pasó, cuánto cuesta la reparación ni si el vehículo está en taller.
*Con OPSLOG:* el responsable de siniestros crea el caso (vehículo, conductor, fecha, lugar, tipo, severidad), adjunta fotos desde el teléfono, registra aseguradora, número de reporte y ajustador. El caso avanza por estados; cada cambio queda en el timeline con responsable. Si pasa X días sin actualización, se escala al gerente.

**Escenario C — Mantenimiento no planificado.**
*Hoy:* el cambio de aceite se hace "cuando el conductor avisa". No hay registro de costo ni factura.
*Con OPSLOG:* el vehículo tiene un plan preventivo cada 10.000 km o 6 meses. El sistema genera la alerta, el responsable programa el servicio, el mecánico registra lo realizado, refacciones, costo y factura. El historial del vehículo muestra todo.

**Escenario D — Despachador sin información.**
*Hoy:* el despachador asigna un viaje a un vehículo que está en el taller desde ayer; se entera cuando el conductor no sale.
*Con OPSLOG:* el estado "Fuera de servicio — en taller" es visible en la consulta del despachador y, si hay integración, se envía al despacho vía webhook.

**Escenario E — Auditoría del cliente corporativo.**
*Hoy:* un cliente pide evidencia de que todos los conductores asignados tienen licencia vigente y los vehículos seguro. Se arma una carpeta a mano en dos días.
*Con OPSLOG:* reporte "Cumplimiento documental" filtrado por área/cliente, exportado a PDF con fecha de corte.

---

## 4. TARGET CUSTOMERS

### 4.1 Perfiles de empresa [CONFIRMED como lista; caracterización PROPOSED]

| Perfil | Característica distintiva | Módulos de mayor valor | Consideraciones |
|---|---|---|---|
| Transporte corporativo / ejecutivo | Flota propia o mixta; clientes corporativos exigentes en cumplimiento. | Documentos, seguros, siniestros, reportes para clientes. | Reportes exportables por cliente/área. |
| Transporte de personal | Rutas fijas, vehículos de mayor capacidad; conductores asignados a turnos. | Plantilla, mantenimiento, despachadores por turno. | Campo "turno" en despachadores y conductores. |
| Logística / última milla | Alta rotación de conductores; flotas grandes. | Plantilla, siniestros, mantenimiento por km. | Volumen alto de registros; importación masiva. |
| Servicios industriales (mineras, energía, construcción) | Vehículos asignados a áreas/proyectos; mantenimiento por horas de operación. | Áreas jerárquicas, mantenimiento por horas, documentación regulatoria. | Mantenimiento por horas [ASSUMPTION]. |
| Empresas con flota tercerizada | Los vehículos pertenecen a proveedores; la empresa controla cumplimiento. | Documentación, seguros, siniestros. | Entidad "Proveedor / Propietario del vehículo" [PROPOSED]. |
| Operaciones con vehículos asignados (ventas, servicio técnico) | Vehículo asignado a empleado no-conductor profesional. | Vehículos, mantenimiento, siniestros. | "Conductor" debe poder modelar empleados generales [PROPOSED]. |

### 4.2 Características de la empresa ideal [PROPOSED]
- Entre 10 y 500+ vehículos; 20 a 1.000+ conductores. Por debajo de 10 vehículos, una planilla alcanza; el límite superior lo define escalabilidad (§23).
- Ya tiene un sistema de despacho (propio o de terceros) y no quiere cambiarlo.
- Tiene al menos una persona con rol de responsable de flotilla o administrativo de operaciones.
- Sufre vencimientos, siniestros recurrentes o auditorías de clientes.
- Opera en uno o varios países de habla hispana en Latinoamérica [ASSUMPTION — basado únicamente en la terminología del brief, que es mexicana; los mercados objetivo no fueron definidos; configurabilidad de etiquetas por país en §7].

### 4.3 Señales de que **no** es cliente objetivo [PROPOSED]
- Busca despacho, tracking o tarificación (producto distinto).
- Flota de 1–5 vehículos sin personal administrativo.

---

## 5. PERSONAS Y ROLES

Los siete roles siguientes son [CONFIRMED]. Sus objetivos, información y restricciones detalladas son [PROPOSED] salvo donde se indique.

### 5.1 Administrador de empresa
- **Objetivo:** dejar la plataforma configurada para su empresa y mantener usuarios y catálogos.
- **Responsabilidades [CONFIRMED]:** configuración, usuarios, roles, catálogos, áreas, configuración operativa.
- **Información que necesita:** lista de usuarios y su estado, roles y permisos, catálogos (tipos de vehículo, tipos de mantenimiento, tipos de siniestro, aseguradoras, talleres), parámetros (umbrales de alerta, SLA, campos obligatorios), uso de la suscripción.
- **Acciones permitidas:** CRUD de usuarios, asignación de roles, creación de roles personalizados, CRUD de catálogos y áreas, edición de configuración, consulta del audit log completo, exportaciones.
- **Información restringida:** ninguna dentro de su empresa; **nunca** datos de otras empresas. [CONFIRMED — aislamiento multi-tenant]
- **Riesgo:** [RISK] concentración de poder; mitigación: todas sus acciones auditadas, posibilidad de requerir segundo administrador para acciones destructivas (ver §19).

### 5.2 Responsable de flotilla
- **Objetivo:** que todos los vehículos estén operativos, documentados, asegurados y mantenidos.
- **Responsabilidades [CONFIRMED]:** vehículos, conductores, mantenimientos, documentación, seguros, historial.
- **Información que necesita:** estado de cada vehículo, vencimientos próximos, mantenimientos programados y vencidos, conductor asignado, historial.
- **Acciones permitidas:** CRUD vehículos y conductores, asignar/desasignar conductor–vehículo, cambiar estado del vehículo, cargar documentos y pólizas, programar y cerrar mantenimientos, asociar mecánico/taller, exportar reportes de su dominio.
- **Información restringida:** configuración de empresa, gestión de usuarios, costos de siniestros si la empresa lo decide [DECISION REQUIRED].

### 5.3 Despachador
- **Objetivo:** saber, antes de asignar un viaje, si el vehículo y el conductor están en condiciones de operar.
- **Responsabilidades [CONFIRMED]:** consulta de plantilla, consulta de conductores, consulta de vehículos, información operativa relevante.
- **Información que necesita:** disponibilidad y estado de vehículos y conductores, motivo de no disponibilidad, vencimientos críticos (seguro vencido, licencia vencida), vehículo asignado a cada conductor, contacto.
- **Acciones permitidas:** solo lectura por defecto. [PROPOSED] Opcionalmente: reportar un siniestro en estado `Draft` (el despachador suele ser el primero en enterarse). [DECISION REQUIRED]
- **Información restringida:** costos, pólizas completas, documentos personales de conductores, configuración.

### 5.4 Responsable de siniestros
- **Objetivo:** gestionar cada siniestro de principio a fin con evidencia completa y mínimo costo para la empresa.
- **Responsabilidades [CONFIRMED]:** crear siniestros, gestionar casos, actualizar información, adjuntar evidencia, cambiar estados, dar seguimiento.
- **Información que necesita:** datos del vehículo y conductor involucrados, póliza vigente y contacto de la aseguradora, estado del caso, evidencias, costos, deducible, taller de reparación, SLA.
- **Acciones permitidas:** crear/editar siniestros, transicionar estados (según workflow), adjuntar evidencias, registrar terceros, costos, reparaciones, asignar casos, cerrar y reabrir (reapertura según permiso).
- **Información restringida:** edición de datos maestros de vehículos y conductores (solo consulta), configuración.

### 5.5 Mecánico
- **Objetivo:** registrar diagnósticos y trabajos realizados con el menor esfuerzo posible, idealmente desde el taller.
- **Responsabilidades [CONFIRMED]:** mantenimientos, diagnósticos, servicios realizados, historial.
- **Información que necesita:** orden de mantenimiento asignada, datos del vehículo, kilometraje, historial de servicios, refacciones usadas antes.
- **Acciones permitidas:** ver mantenimientos asignados, registrar diagnóstico, registrar servicio realizado, refacciones, costo (si la empresa lo permite), adjuntar evidencias y facturas, cambiar estado de la orden entre `Asignado` → `En proceso` → `Completado`.
- **Información restringida:** otros módulos; datos personales de conductores; siniestros (salvo la reparación asociada si se le asigna).
- [ASSUMPTION] El mecánico puede ser **interno** (usuario de la empresa) o **externo** (taller proveedor). Para el externo, [DECISION REQUIRED]: ¿tiene usuario con acceso limitado o el responsable de flotilla registra por él? Esto afecta licenciamiento, seguridad y UX móvil.

### 5.6 Supervisor / Gerente
- **Objetivo:** visibilidad y control sin operar el día a día.
- **Responsabilidades [CONFIRMED]:** consulta, seguimiento, reportes, indicadores.
- **Información que necesita:** dashboard, KPIs, alertas escaladas, siniestros críticos, costos agregados, reportes.
- **Acciones permitidas:** consulta de todos los módulos, exportaciones, aprobación de acciones que la empresa configure como aprobables (p. ej. cierre de siniestro con costo > umbral, baja de vehículo) [PROPOSED], recepción de escalaciones.
- **Información restringida:** configuración de usuarios/roles (salvo que la empresa lo habilite).

### 5.7 Usuario de consulta
- **Objetivo:** acceder solo a lo autorizado. [CONFIRMED]
- **Acciones permitidas:** `View` sobre los módulos/áreas habilitados. Opcionalmente `Export`. [PROPOSED]
- **Casos típicos:** auditor del cliente corporativo, contador, RR.HH.
- [PROPOSED] El alcance puede restringirse por **área** (ver §6.4), lo que permite dar acceso a un cliente corporativo a "sus" vehículos únicamente.

### 5.8 Actores no humanos [PROPOSED]
| Actor | Descripción |
|---|---|
| Sistema de despacho externo | Consume/produce datos vía API o webhooks. Identidad: API key o OAuth client por empresa. |
| Scheduler interno | Evalúa vencimientos, SLA y genera notificaciones. |
| Super-administrador de plataforma (proveedor de OPSLOG) | Crea empresas, gestiona suscripciones, soporte. No accede a datos operativos de las empresas sin consentimiento registrado [PROPOSED — ver §23 Privacy]. |

---

## 6. USER ACCESS & RBAC

### 6.1 Modelo [PROPOSED]
- **Permisos** atómicos con forma `módulo:acción` (p. ej. `vehicles:edit`, `incidents:close`).
- **Roles** = conjuntos de permisos. Existen **roles de sistema** (plantillas no editables: los siete de §5) y **roles personalizados por empresa** (copias editables).
- Un usuario tiene **uno o más roles** dentro de una empresa. Los permisos se unen (OR).
- **Alcance (scope)** opcional por **área**: un rol puede asignarse "para toda la empresa" o "solo para las áreas X, Y". [PROPOSED] [DECISION REQUIRED — agrega complejidad; recomendado para usuario de consulta y supervisor, diferible para MVP]
- Un usuario (identidad = e-mail) puede pertenecer a **varias empresas** con roles distintos en cada una; al iniciar sesión elige la empresa activa. [PROPOSED] Caso real: consultor o proveedor que trabaja para dos clientes. [DECISION REQUIRED]

### 6.2 Catálogo de acciones [CONFIRMED como lista; semántica PROPOSED]
| Acción | Semántica |
|---|---|
| `view` | Ver listados y detalles. |
| `create` | Crear registros. |
| `edit` | Modificar registros no cerrados. |
| `delete` | Eliminar (soft delete, ver §19). |
| `export` | Exportar listados/reportes. |
| `approve` | Aprobar acciones configuradas como aprobables. |
| `assign` | Asignar responsables (siniestro a usuario, vehículo a conductor, orden a mecánico). |
| `close` | Llevar un registro a estado terminal. |
| `reopen` | Reabrir un registro cerrado. |
| `upload_evidence` | Adjuntar archivos/fotos. |
| `manage_users` | Crear/editar usuarios y asignar roles. |
| `manage_config` | Editar configuración, catálogos, roles personalizados. |
| `view_costs` | [PROPOSED — adicional] Ver importes (costos, deducibles, facturas). Separa información financiera. |
| `view_pii` | [PROPOSED — adicional] Ver datos personales sensibles de conductores (identificación, documentos). |
| `view_audit` | [PROPOSED — adicional] Ver audit trail. |

### 6.3 Matriz rol × módulo × acción (roles de sistema por defecto) [PROPOSED]

Leyenda: V=view, C=create, E=edit, D=delete, X=export, A=approve, S=assign, Cl=close, R=reopen, U=upload_evidence, $=view_costs, P=view_pii.

| Módulo | Admin empresa | Resp. flotilla | Despachador | Resp. siniestros | Mecánico | Supervisor | Consulta |
|---|---|---|---|---|---|---|---|
| Dashboard | V | V | V (limitado) | V (limitado) | – | V | V |
| Usuarios y roles | V C E D (manage_users) | – | – | – | – | V | – |
| Configuración / catálogos | manage_config | V | – | – | – | V | – |
| Áreas | V C E D | V | V | V | – | V | V |
| Conductores | V C E D X P | V C E D X P | V | V | – | V X | V |
| Despachadores | V C E D X | V C E X | V | – | – | V X | V |
| Vehículos | V C E D X S | V C E D X S | V | V | V | V X | V |
| Documentos vehículo | V C E D U | V C E D U | V (vigencia) | V | – | V | V |
| Seguros | V C E D X $ | V C E D X $ | V (vigencia) | V $ | – | V X $ | – |
| Mecánicos / talleres | V C E D | V C E D | – | V | V | V | – |
| Mantenimiento | V C E D X S Cl $ | V C E D X S Cl $ | V | V | V E U Cl (propios) | V X $ | V |
| Siniestros | V C E D X S Cl R U $ | V | V (C en Draft, opcional) | V C E X S Cl U $ | V (reparación asignada) | V X A $ R | V |
| Reportes | V X | V X (su dominio) | – | V X (siniestros) | – | V X | V X (opcional) |
| Audit trail | V (view_audit) | V (propio dominio) | – | V (siniestros) | – | V | – |
| Notificaciones | config + V | V | V | V | V | V | V |

### 6.4 Configuración por empresa [PROPOSED]
- El administrador puede: clonar un rol de sistema, renombrarlo, agregar/quitar permisos, asignarlo con o sin alcance por área.
- Permisos "peligrosos" (`delete`, `reopen`, `manage_users`, `manage_config`) muestran advertencia al agregarse a roles personalizados.
- La plataforma mantiene un **mínimo invariante**: toda empresa tiene al menos un usuario activo con `manage_users` y `manage_config` (no se puede quitar al último).
- Cambios de roles y permisos quedan en el audit trail.

### 6.5 Reglas de acceso transversales
| ID | Regla |
|---|---|
| AC-1 | Un usuario solo ve datos de la empresa activa en su sesión. [CONFIRMED] |
| AC-2 | Todo acceso a API se autoriza con el mismo modelo de permisos que la UI. [PROPOSED] |
| AC-3 | Los archivos (documentos/fotos) se sirven mediante URLs firmadas de corta duración, nunca públicas. [PROPOSED] |
| AC-4 | La desactivación de un usuario invalida sus sesiones y tokens de inmediato. [PROPOSED] |
| AC-5 | Super-admin de plataforma no tiene acceso a datos operativos salvo "impersonación de soporte" con consentimiento y registro en audit. [PROPOSED] [DECISION REQUIRED] |

---

## 7. PRODUCT MODULES

### 7.0 Arquitectura funcional [PROPOSED]

```
┌─────────────────────────────────────────────────────────────────────┐
│  PLATAFORMA (proveedor)                                             │
│  Empresas · Suscripciones · Super-admin · Monitoreo                 │
├─────────────────────────────────────────────────────────────────────┤
│  EMPRESA (tenant)                                                   │
│  ┌───────────────┐ ┌──────────────┐ ┌──────────────────────────┐    │
│  │ Configuración │ │ Usuarios/RBAC│ │ Áreas (jerárquicas)      │    │
│  └───────┬───────┘ └──────┬───────┘ └────────────┬─────────────┘    │
│          └────────────────┴──────────────────────┘                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Plantilla    │  │ Vehículos    │  │ Mecánicos /  │               │
│  │ Conductores  │◄─┤ Documentos   ├─►│ Talleres     │               │
│  │ Despachadores│  │ Seguros      │  └──────┬───────┘               │
│  └──────┬───────┘  │ Fotos        │         │                       │
│         │          └──────┬───────┘         │                       │
│         │                 │                 │                       │
│  ┌──────▼─────────────────▼─────────────────▼──────┐                │
│  │ Mantenimiento            Siniestros / Workflow  │                │
│  └──────────────────────┬──────────────────────────┘                │
│  ┌──────────────────────▼──────────────────────────┐                │
│  │ Documentos & Evidencias (servicio transversal)  │                │
│  └─────────────────────────────────────────────────┘                │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │ Dashboard    │ │ Reportes     │ │ Notificac.  │ │ Audit trail │  │
│  └──────────────┘ └──────────────┘ └─────────────┘ └─────────────┘  │
│  ┌─────────────────────────────────────────────────┐                │
│  │ Búsqueda global · API pública · Webhooks · Import│               │
│  └─────────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
```

Módulos: Dashboard (7.1), Plantilla operativa (7.2), Vehículos (8), Mantenimiento (9), Siniestros (10–11), Documentos y evidencias (12), Reportes (13), Búsqueda (14), Notificaciones (15), Audit trail (16), Configuración y catálogos (7.3 — [PROPOSED] no estaba como módulo explícito pero es prerrequisito), Integraciones (18).

### 7.1 Dashboard

**Widgets [CONFIRMED]:** vehículos activos, vehículos fuera de servicio, conductores activos, mantenimientos próximos, documentos por vencer, seguros por vencer, siniestros abiertos, siniestros críticos, indicadores operativos.

**Comportamiento [PROPOSED]:**
- Cada widget es un contador o lista corta con enlace al listado filtrado correspondiente (drill-down).
- Filtro global por **área** y por **rango de fechas** donde aplique.
- El contenido respeta permisos: un despachador ve disponibilidad y vencimientos críticos, no costos.
- "Próximo a vencer" usa umbrales configurables por empresa (por defecto 30 días; ver §15).
- "Siniestro crítico" = severidad `Alta`/`Crítica` o SLA vencido [PROPOSED — definición a validar].
- Indicadores operativos del MVP: los de §2.6 que no dependen de integración (disponibilidad, % documentación vigente, % seguros vigentes, siniestros abiertos/cerrados, cumplimiento de mantenimiento). [PROPOSED]
- Widgets configurables (mostrar/ocultar, orden) por rol: [PROPOSED — fase 2].

### 7.2 Bitácora de plantilla operativa

#### 7.2.1 Conductores
Campos [CONFIRMED como lista]; obligatoriedad [PROPOSED]:

| Campo | Obligatorio | Configurable por empresa | Notas |
|---|---|---|---|
| Nombre | Sí | – | |
| Apellidos | Sí | – | |
| Fotografía | No | Puede volverse obligatoria | |
| Teléfono | Sí | – | Formato internacional validado |
| Correo | No | Puede volverse obligatorio | Único por empresa si se informa |
| Identificación (tipo + número) | Sí | Tipo de documento según país (CURP/INE, CI, DNI, CPF…) | PII; permiso `view_pii` |
| Número de empleado | No | Puede volverse obligatorio; único por empresa | |
| Área | Sí | – | FK a Área |
| Puesto | No | Catálogo por empresa | |
| Fecha de ingreso | No | Puede volverse obligatoria | |
| Estatus | Sí | Valores de sistema: `Activo`, `Inactivo`, `Suspendido`, `Baja` [PROPOSED]; la empresa puede agregar sub-estados | |
| Licencia (número) | Sí para operar | – | |
| Tipo de licencia | Sí | Catálogo por empresa/país | |
| Vigencia de licencia | Sí | – | Genera alertas |
| Documentación | No | Tipos requeridos configurables | Ver §12 |
| Historial | Auto | – | Asignaciones, siniestros, cambios de estado |
| Vehículo asignado | No | – | Derivado de asignaciones vigentes |
| Observaciones | No | – | |
| **Tipo de vinculación** | No | [PROPOSED — adicional] `Empleado directo` / `Contratista independiente` / `Tercerizado (proveedor)` | Relevante multi-país |
| **Campos personalizados** | – | [PROPOSED] hasta N campos tipados por empresa | Evita forks del producto |

Reglas:
- Un conductor `Inactivo`/`Baja` no puede recibir asignación de vehículo. [PROPOSED]
- Licencia vencida ⇒ bandera visible "No apto para operar"; cambio automático de estatus es configurable. [PROPOSED] [DECISION REQUIRED]
- [PROPOSED] Importación masiva por CSV/Excel con plantilla y validación previa (necesaria para onboarding de clientes con cientos de conductores).

#### 7.2.2 Despachadores
Campos [CONFIRMED]: nombre, teléfono, correo, área, puesto, turno, supervisor, estatus, información de contacto.
- [PROPOSED] Un despachador puede o no ser usuario de la plataforma (son entidades distintas; se pueden vincular). Esto permite registrar la plantilla de despacho sin dar licencia de acceso a todos.
- [PROPOSED] Turno: catálogo por empresa (p. ej. mañana/tarde/noche o franjas horarias).
- [PROPOSED] Supervisor: FK a otro registro de plantilla (despachador o usuario).
- [DECISION REQUIRED] ¿Se gestionan otros perfiles de plantilla (supervisores de campo, administrativos) como entidad genérica `Employee` con tipo? Recomendado: sí, `Employee` genérico con subtipos `Driver` y `Dispatcher` (ver §17).

#### 7.2.3 Áreas
Capacidades [CONFIRMED]: crear, editar, activar/desactivar, asignar trabajadores, asociar responsables.
- [PROPOSED] Estructura **jerárquica** (árbol): p. ej. País → Ciudad → Base, o Cliente → Contrato. Profundidad máxima sugerida: 4.
- [PROPOSED] Un vehículo y un conductor pertenecen a **una** área a la vez; el historial de cambios de área se registra.
- [PROPOSED] Responsable(s) del área: usuarios que reciben notificaciones y escalaciones de esa área.
- [PROPOSED] Desactivar un área con recursos activos requiere reasignarlos primero (validación).
- [PROPOSED] El alcance de permisos por área (§6.1) se hereda hacia abajo en el árbol.

### 7.3 Configuración y catálogos [PROPOSED — módulo necesario no listado en el brief]
Elementos configurables por empresa:

| Grupo | Elementos |
|---|---|
| Identidad | Nombre, logo, zona horaria, país por defecto, moneda, idioma, formato de fecha. |
| Etiquetas | Renombrar etiquetas de campos clave (p. ej. "Placas" → "Matrícula", "Número económico" → "Interno"). |
| Catálogos | Tipos de vehículo, marcas/modelos (con sugerencias globales), tipos de documento (vehículo y persona), tipos de licencia, puestos, turnos, tipos de mantenimiento, tipos de siniestro, severidades, aseguradoras, talleres, especialidades, motivos de fuera de servicio. |
| Campos | Obligatoriedad de campos opcionales; campos personalizados. |
| Workflow | Estados adicionales de siniestro, evidencias requeridas por transición, SLA por severidad, aprobaciones requeridas. |
| Alertas | Umbrales de anticipación por tipo (días/km), canales, destinatarios por área. |
| Mantenimiento | Planes preventivos por tipo de vehículo (intervalo por fecha/km/horas). |
| Numeración | Prefijos y secuencias para folios de siniestros y órdenes de mantenimiento. |
| Integraciones | API keys, webhooks, mapeo de identificadores externos. |
| Retención | Períodos de retención documental (dentro de límites de plataforma). |

---

## 8. VEHICLE MANAGEMENT

### 8.1 Información general
Campos [CONFIRMED]; obligatoriedad [PROPOSED]:

| Campo | Obligatorio | Notas |
|---|---|---|
| Número económico (interno) | Sí | Único por empresa; etiqueta configurable |
| Placas | Sí | Único por empresa; se admite historial de placas [PROPOSED] |
| VIN | No (recomendado) | Único global si se informa; validación de 17 caracteres |
| Marca | Sí | Catálogo |
| Modelo | Sí | Catálogo dependiente de marca |
| Año | Sí | Rango validado |
| Tipo | Sí | Catálogo (sedán, van, bus, camioneta, utilitario…) |
| Color | No | |
| Capacidad | No | Pasajeros y/o carga; según tipo |
| Kilometraje | Sí (odómetro actual) | Solo incrementa; ver regla BR-V5 |
| Estado | Sí | Ver 8.6 |
| Fecha de alta | Sí | Default: hoy |
| Área | Sí | FK |
| Conductor asignado | No | Derivado de asignación vigente; ver 8.7 |
| Ubicación (si aplica) | No | Texto o base/estacionamiento de catálogo; no GPS en tiempo real [PROPOSED] |
| **Propiedad** | No | [PROPOSED — adicional] `Propio` / `Arrendado` / `Tercerizado` + proveedor/propietario. Clave para flotas tercerizadas. |
| **Combustible / motorización** | No | [PROPOSED — adicional] Útil para planes de mantenimiento y reportes. |
| **Horómetro** | No | [ASSUMPTION] Solo si la empresa habilita mantenimiento por horas. |
| **Identificador externo (despacho)** | No | [PROPOSED] Para integración; puede haber varios (uno por sistema). |

### 8.2 Información documental [CONFIRMED]
Tarjeta de circulación, registro, documentos regulatorios, fechas de expiración.
- [PROPOSED] Los tipos de documento son un catálogo por empresa, con atributos: nombre, obligatorio sí/no, tiene vencimiento sí/no, días de anticipación de alerta, aplica a tipo de vehículo.
- [PROPOSED] Ejemplos de catálogo semilla por país (a validar): tarjeta de circulación, verificación vehicular/ITV, permiso de transporte de pasajeros, SOAT/seguro obligatorio, VTV, licencia de taxi/remise, habilitación municipal.
- Vencimiento ⇒ alerta ⇒ opcionalmente estado `Restringido` (ver 8.6).

### 8.3 Fotografías [CONFIRMED]
- Fotografías del vehículo, por ángulo (frente, atrás, lateral izq., lateral der., interior, tablero/odómetro) [PROPOSED — set por defecto configurable], evidencia de daños, documentos escaneados.
- [PROPOSED] "Set de inspección" fechado: conjunto de fotos por ángulo tomado en un momento (alta, cambio de conductor, pre/post siniestro). Permite comparar estado antes/después.
- [PROPOSED] Captura desde móvil (web responsive con acceso a cámara) con compresión en cliente.

### 8.4 Seguro [CONFIRMED]
Aseguradora, póliza (documento), cobertura, número de póliza, fecha de inicio, fecha de expiración, deducible, documentación, contacto.
- [PROPOSED] Un vehículo puede tener **varias pólizas** a lo largo del tiempo y más de una vigente (p. ej. obligatoria + todo riesgo). Se modela `InsurancePolicy` con relación N:1 a vehículo, o N:M si una póliza de flota cubre varios vehículos. [DECISION REQUIRED — pólizas de flota son comunes; recomendado soportar N:M con "póliza de flota" en fase 2 y 1:N en MVP.]
- [PROPOSED] Cobertura: texto libre + checklist configurable (RC, daños propios, robo, cristales, asistencia).
- [PROPOSED] Deducible: monto o porcentaje + moneda.
- [PROPOSED] Contacto de siniestros de la aseguradora (teléfono 24 h, correo, portal) a nivel de aseguradora (catálogo) con override por póliza.

### 8.5 Mecánico [CONFIRMED]
Asociar mecánico, taller, contacto, especialidad.
- [PROPOSED] Catálogo de **talleres** (razón social, dirección, contacto, especialidades, interno/externo) y de **mecánicos** (persona, taller al que pertenece, especialidad, contacto, usuario vinculado opcional).
- [PROPOSED] Un vehículo tiene un mecánico/taller "preferido" (default para órdenes), no exclusivo.

### 8.6 Estados del vehículo [PROPOSED — el brief exige estado pero no define valores]
| Estado | Significado | ¿Despachable? |
|---|---|---|
| `Activo` | Operativo y en condiciones. | Sí |
| `Restringido` | Operativo con alerta (documento/seguro vencido o próximo). Configurable si bloquea. | Configurable |
| `En mantenimiento` | En taller por orden de mantenimiento abierta. | No |
| `Fuera de servicio` | No operativo por siniestro, avería o decisión; requiere motivo (catálogo). | No |
| `Inactivo` | Temporalmente sin uso (p. ej. temporada). | No |
| `Baja` | Dado de baja (venta, pérdida total, fin de arrendamiento). Terminal; conserva historial. | No |

- Transiciones automáticas sugeridas: apertura de orden de mantenimiento con "requiere taller" ⇒ `En mantenimiento`; siniestro con "vehículo inoperable" ⇒ `Fuera de servicio`; cierre de ambos ⇒ vuelve al estado anterior (requiere confirmación humana [PROPOSED]). [DECISION REQUIRED — ¿automático o sugerido?]
- Todo cambio de estado registra motivo, usuario, fecha y queda en historial.

### 8.7 Asignación conductor–vehículo [PROPOSED — detalle necesario para BR "no dos conductores principales"]
- Entidad `VehicleAssignment` con: vehículo, conductor, tipo (`Principal` / `Secundario` / `Temporal`), fecha-hora inicio, fecha-hora fin (null = vigente), motivo, usuario que asigna.
- Reglas: a lo sumo **una** asignación `Principal` vigente por vehículo; un conductor puede tener a lo sumo **una** asignación `Principal` vigente [PROPOSED — el brief fija la primera; la segunda es recomendación] [DECISION REQUIRED]. Asignaciones `Secundario`/`Temporal` sin límite.
- [ASSUMPTION] En transporte de personal por turnos, un vehículo tiene varios conductores por día ⇒ se usan asignaciones `Temporal` o se desactiva la unicidad por configuración.

### 8.8 Historial [CONFIRMED]
Timeline unificado por vehículo: asignaciones, cambios de estado/área/placas, mantenimientos, siniestros, reparaciones, documentos (altas, vencimientos, renovaciones), modificaciones de datos maestros (desde audit), pólizas. Filtrable por tipo de evento y rango de fechas; exportable.

---

## 9. MAINTENANCE MANAGEMENT

### 9.1 Conceptos [PROPOSED]
- **Plan de mantenimiento** (preventivo): regla recurrente asociada a un vehículo o tipo de vehículo. Disparador por **fecha** (cada N días/meses), **kilometraje** (cada N km) u **horas de operación** (cada N h) [ASSUMPTION — horas solo si la empresa registra horómetro], o lo que ocurra primero.
- **Orden de mantenimiento** (work order): instancia concreta de un servicio, preventivo (generado por plan o manual) o correctivo (por falla, inspección o siniestro).

### 9.2 Datos de la orden [CONFIRMED como lista]
Tipo (preventivo/correctivo), tipo de mantenimiento (catálogo: aceite, frenos, neumáticos, inspección…), vehículo, kilometraje al momento, fecha programada, fecha de realización, mecánico, taller, costo (mano de obra, refacciones, total, moneda), refacciones (líneas: descripción, cantidad, costo unitario), evidencias (fotos antes/después), facturas (archivos + número + proveedor), observaciones, diagnóstico [PROPOSED], responsable interno [CONFIRMED — "debe registrar responsable"], siniestro origen (opcional, FK) [PROPOSED], próximo servicio sugerido (fecha/km) [PROPOSED].

### 9.3 Estados y workflow [PROPOSED]

```
Programado ──► Asignado ──► En proceso ──► Completado ──► Cerrado
    │              │             │
    └──────────────┴─────────────┴──► Cancelado
```

| Estado | Entra cuando | Quién | Sale a |
|---|---|---|---|
| `Programado` | Plan genera orden o usuario crea manualmente. | Sistema / Resp. flotilla | Asignado, Cancelado |
| `Asignado` | Se asigna mecánico/taller y fecha. | Resp. flotilla | En proceso, Cancelado |
| `En proceso` | Mecánico inicia; vehículo pasa a `En mantenimiento` si "requiere taller". | Mecánico / Resp. flotilla | Completado, Cancelado |
| `Completado` | Mecánico registra trabajos, refacciones, km, evidencias. | Mecánico | Cerrado |
| `Cerrado` | Resp. flotilla valida costo/factura; vehículo vuelve a operativo; se recalcula próximo servicio. | Resp. flotilla | (terminal; reapertura con permiso) |
| `Cancelado` | Con motivo. | Resp. flotilla | (terminal) |

- [DECISION REQUIRED] ¿Se necesita paso de **aprobación de presupuesto** antes de `En proceso` cuando el costo estimado supera un umbral? Recomendado como opcional por empresa.

### 9.4 Reglas de negocio [PROPOSED]
| ID | Regla |
|---|---|
| BR-M1 | Toda orden registra responsable interno (usuario) además del mecánico. [CONFIRMED] |
| BR-M2 | `Completado` requiere: kilometraje ≥ último registrado, al menos un tipo de trabajo, fecha de realización. Evidencia fotográfica y factura son requeridas según configuración de la empresa. |
| BR-M3 | Al cerrar una orden preventiva generada por plan, se calcula la siguiente ocurrencia (fecha y/o km). |
| BR-M4 | Una orden correctiva puede originarse desde un siniestro; en ese caso, los costos se reflejan también en el siniestro. |
| BR-M5 | El kilometraje registrado en la orden actualiza el odómetro del vehículo si es mayor al actual; si es menor, se exige confirmación y motivo (corrección de odómetro) y queda auditado. |
| BR-M6 | No se puede eliminar una orden en `Completado`/`Cerrado`; solo cancelar con motivo antes de completar. |

### 9.5 Alertas [PROPOSED]
- "Mantenimiento próximo": cuando falte ≤ N días o ≤ N km (configurable; default 15 días / 500 km) para el próximo preventivo.
- "Mantenimiento vencido": superada la fecha/km sin orden `Completado`.
- "Orden sin avance": orden `Asignado`/`En proceso` sin actualización en N días.
- [DEPENDENCY] Las alertas por km dependen de que el odómetro se actualice: manualmente, por órdenes, o por integración con despacho/telemetría. [RISK] Sin fuente confiable de km, las alertas por km serán inexactas; mitigación: alerta por fecha como respaldo y campo "última actualización de odómetro" visible.

### 9.6 Historial
Por vehículo: todas las órdenes con costo acumulado, por tipo; por mecánico/taller: órdenes atendidas, costo, tiempos. Base para reportes de §13.

---

## 10. INCIDENT / CLAIM MANAGEMENT

### 10.1 Alcance
Siniestros e incidentes [CONFIRMED]. [PROPOSED] Se usa el término **Incidente** como entidad general con **tipo** (catálogo) que incluye: colisión, vuelco, robo total/parcial, vandalismo, daño en estacionamiento, falla mecánica en ruta, infracción de tránsito, lesión a pasajero/tercero, otro. "Siniestro" se reserva para incidentes con proceso de aseguradora. [DECISION REQUIRED — ¿incluir infracciones de tránsito en este módulo o en uno separado?]

### 10.2 Datos del incidente [CONFIRMED como lista; agrupación PROPOSED]

| Grupo | Campos |
|---|---|
| Identificación | Folio (auto, prefijo configurable), tipo, severidad (`Baja`/`Media`/`Alta`/`Crítica` [PROPOSED]), estado, responsable asignado, área. |
| Qué, cuándo, dónde | Fecha/hora del evento, fecha/hora de reporte, ubicación (texto + opcional lat/long + enlace a mapa), descripción, referencia de viaje externo [PROPOSED]. |
| Quién | Vehículo (obligatorio) [CONFIRMED], conductor (opcional) [CONFIRMED], pasajeros afectados (cantidad / detalle) [PROPOSED], reportado por. |
| Terceros | Lista: tipo (persona/vehículo/propiedad), nombre, contacto, placas, aseguradora del tercero, póliza del tercero, descripción de daños, lesiones sí/no. |
| Daños | Descripción, partes afectadas (checklist por zona), ¿vehículo operable? (sí/no ⇒ estado del vehículo), estimación inicial. |
| Evidencia | Fotografías, videos [PROPOSED], documentos (parte policial, declaración del conductor, croquis, presupuestos). |
| Seguro | Aseguradora, número de póliza (precargado desde la póliza vigente a la fecha del evento), número de reporte/siniestro, ajustador (nombre, contacto), fecha de reporte a aseguradora, resultado (aceptado/rechazado/parcial), motivo de rechazo. |
| Costos | Deducible, costo de reparación, costo cubierto por seguro, costo a cargo de la empresa, costo a cargo del conductor [PROPOSED — práctica común] [DECISION REQUIRED], otros costos (grúa, multas), moneda. |
| Reparación | Vínculo a una o más órdenes de mantenimiento correctivo (§9); taller; fechas de ingreso/salida. |
| Seguimiento | Timeline de comentarios, cambios de estado, tareas pendientes con responsable y fecha [PROPOSED]. |
| Legal [PROPOSED] | ¿Hay proceso legal/policial? Número de expediente, estado. |

### 10.3 Reglas [PROPOSED salvo indicación]
| ID | Regla |
|---|---|
| BR-I1 | Un incidente debe estar asociado a un vehículo de la empresa. [CONFIRMED] |
| BR-I2 | Un incidente puede estar asociado a un conductor; si el vehículo tenía asignación vigente a la fecha/hora del evento, se sugiere ese conductor. [CONFIRMED + PROPOSED] |
| BR-I3 | Al crear, el sistema muestra la póliza vigente a la fecha del evento; si no hay, alerta visible "Sin cobertura vigente a la fecha del evento". |
| BR-I4 | La fecha del evento no puede ser futura ni anterior a la fecha de alta del vehículo. |
| BR-I5 | Si "vehículo operable = No", se propone cambio de estado del vehículo a `Fuera de servicio` con motivo "Siniestro {folio}". |
| BR-I6 | Los importes solo son visibles con `view_costs`. |
| BR-I7 | El incidente cerrado es inmutable salvo reapertura (permiso `reopen`) con motivo; la reapertura queda en audit. |

---

## 11. INCIDENT WORKFLOW

### 11.1 Estados [PROPOSED — el ejemplo del brief no es definitivo]

```
                                    ┌──────────────────────────┐
                                    ▼                          │
Draft ─► Reported ─► Under Review ─┬─► Insurance Process ─┬─► Repair ─► Resolved ─► Closed
                         │         │          │           │               ▲            │
                         │         │          ▼           │               │            ▼
                         │         │   Insurance Rejected ┘               │        Reopened
                         │         │                                      │            │
                         │         └─► No Insurance (interno) ────────────┘            │
                         ▼                                                             │
                     Cancelled                                      (vuelve a Under Review o Repair)
```

| Estado | Descripción | Información mínima para entrar | Evidencia mínima |
|---|---|---|---|
| `Draft` | Borrador, puede estar incompleto. | Vehículo, tipo. | – |
| `Reported` | Reportado formalmente; inicia SLA. | + fecha/hora, ubicación, descripción, severidad, conductor (o "sin conductor" justificado). | ≥ 1 foto o justificación de ausencia [configurable]. |
| `Under Review` | Investigación interna: recopilación de evidencia, declaración, determinación de responsabilidad. | Responsable asignado. | Declaración del conductor (configurable). |
| `Insurance Process` | Reportado a aseguradora; esperando ajuste/resolución. | Aseguradora, póliza, número de reporte, fecha de reporte. | Parte/denuncia si el tipo lo requiere (configurable). |
| `Insurance Rejected` | Aseguradora rechaza total o parcialmente. | Motivo de rechazo, decisión: apelar / asumir costo. | Carta/comunicación de rechazo. |
| `No Insurance` | Se decide gestionar sin aseguradora (sin póliza, bajo deducible, etc.). | Justificación. | – |
| `Repair` | Vehículo en reparación. | Orden(es) de mantenimiento correctivo vinculadas, taller. | Presupuesto. |
| `Resolved` | Reparación terminada / caso resuelto operativamente; falta cierre administrativo. | Costos finales cargados, vehículo con estado definido. | Factura(s) o evidencia de reparación; fotos post-reparación (configurable). |
| `Closed` | Cierre administrativo y financiero. | Validación por rol autorizado; aprobación si costo > umbral (configurable). | – |
| `Reopened` | Reapertura por nueva evidencia o error. | Motivo. | – |
| `Cancelled` | Creado por error / duplicado. | Motivo. | – |

- [PROPOSED] Estados `Insurance Process`, `Insurance Rejected`, `No Insurance` y `Repair` son **opcionales según el tipo** de incidente: p. ej. una infracción de tránsito va `Reported → Under Review → Resolved → Closed`. La empresa configura qué estados aplican por tipo.
- [PROPOSED] Sub-estado libre "esperando a" (aseguradora / taller / conductor / tercero) para explicar inactividad sin crear más estados.

### 11.2 Transiciones y roles autorizados [PROPOSED]

| Transición | Rol(es) | Condiciones |
|---|---|---|
| Draft → Reported | Resp. siniestros; Despachador (si habilitado); Resp. flotilla | Datos mínimos de `Reported`. |
| Reported → Under Review | Resp. siniestros | Asignar responsable (puede ser uno mismo). |
| Under Review → Insurance Process | Resp. siniestros | Póliza vigente identificada; número de reporte. |
| Under Review → No Insurance | Resp. siniestros | Justificación. |
| Under Review → Repair | Resp. siniestros | Solo si tipo no requiere seguro o se marcó No Insurance. |
| Insurance Process → Repair | Resp. siniestros | Resultado aseguradora = aceptado/parcial. |
| Insurance Process → Insurance Rejected | Resp. siniestros | Motivo. |
| Insurance Rejected → Insurance Process | Resp. siniestros | Apelación (nuevo número de reporte opcional). |
| Insurance Rejected → Repair / Resolved | Resp. siniestros | Decisión de asumir costo; aprobación de Supervisor si costo > umbral (configurable). |
| Repair → Resolved | Resp. siniestros | Órdenes de reparación en `Completado`/`Cerrado`; costos cargados. |
| Insurance Process / Under Review → Resolved | Resp. siniestros | Para casos sin reparación (robo total, solo trámite). |
| Resolved → Closed | Resp. siniestros con `close`; Supervisor con `approve` si aplica | Checklist de cierre completo. |
| Closed → Reopened | Supervisor / Admin con `reopen` | Motivo obligatorio. |
| Reopened → Under Review / Repair | Resp. siniestros | – |
| Cualquiera (no terminal) → Cancelled | Resp. siniestros / Admin | Motivo; solo si no hay costos registrados ni órdenes vinculadas; de lo contrario, cerrar. |

Reglas generales:
- No se permiten saltos fuera de la tabla; la UI solo ofrece las transiciones válidas para el estado y el rol.
- Toda transición registra usuario, fecha/hora, comentario opcional y queda en el timeline y en audit.
- "Falta información": la transición se bloquea y la UI lista los campos/evidencias faltantes (validación declarativa por estado). No se permite "forzar" sin permiso especial `override_workflow` [PROPOSED — restringido a Admin, auditado]. [DECISION REQUIRED]

### 11.3 SLA, notificaciones y escalaciones [PROPOSED]

| Evento | Regla por defecto | Destinatario | Escalación |
|---|---|---|---|
| Nuevo incidente `Reported` | Inmediato | Resp. siniestros del área, Resp. flotilla, Supervisor del área | – |
| Severidad `Alta`/`Crítica` | Inmediato, canal prioritario | + Gerencia | – |
| Sin asignación de responsable | > 4 h hábiles en `Reported` | Resp. siniestros | Supervisor a las 24 h |
| Sin actualización | > N días (default 5) en cualquier estado no terminal | Responsable asignado | Supervisor a 2N días |
| SLA por severidad (Reported → Resolved) | Crítica 7 d · Alta 15 d · Media 30 d · Baja 45 d (valores a validar) | Responsable | Aviso al 80 %; escalación al 100 % |
| Esperando aseguradora | > N días sin resultado | Responsable | Supervisor |
| Cambio de estado | Cada transición | Responsable, creador, suscriptores del caso | – |
| Nueva evidencia en caso cerrado | Al intentar adjuntar | Sugiere reapertura; bloquea adjuntar sin reabrir | – |

- Los valores son defaults a validar por el negocio. [DECISION REQUIRED]
- SLA se mide en días calendario por defecto; configurable a días hábiles con calendario por empresa (fase 2).

### 11.4 Qué ocurre cuando… [CONFIRMED como preguntas; respuestas PROPOSED]
| Situación | Comportamiento |
|---|---|
| Falta información | Transición bloqueada con lista de faltantes; el caso puede quedar en estado actual con tarea pendiente asignada. |
| El seguro rechaza el caso | → `Insurance Rejected`; se registra motivo y comunicación; decisión: apelar (vuelve a `Insurance Process`) o asumir (→ `Repair`/`Resolved`, con aprobación si supera umbral). El costo pasa a "a cargo de la empresa" (o conductor, si la empresa lo configura). |
| El vehículo requiere reparación | → `Repair`; se crea/vincula orden de mantenimiento correctivo; el costo de la orden se refleja en el incidente; vehículo en `En mantenimiento` o `Fuera de servicio`. |
| El vehículo queda fuera de servicio | Al marcar "no operable" se propone cambio de estado del vehículo; el despachador lo ve de inmediato; si hay integración, webhook `vehicle.status_changed`. |
| El siniestro es cerrado | Caso inmutable; se consolidan costos; se actualiza historial de vehículo y conductor; KPIs; se dispara evento `incident.closed`. Vehículo debe tener estado explícito (no puede quedar `Fuera de servicio` con motivo "Siniestro {folio}" sin confirmación). |
| Aparece nueva evidencia | Si caso abierto: se adjunta y notifica al responsable. Si cerrado: se exige reapertura con permiso; la evidencia se adjunta en `Reopened`. |
| Pérdida total / robo | → `Resolved` sin `Repair`; al cerrar se propone dar de baja el vehículo (`Baja`, motivo "pérdida total"/"robo"). [PROPOSED] |
| El conductor es dado de baja durante el caso | El incidente conserva la referencia al conductor (histórico); no se desvincula. |

---

## 12. DOCUMENT & EVIDENCE MANAGEMENT

Servicio transversal usado por vehículos, conductores, despachadores, pólizas, mantenimientos e incidentes. [PROPOSED — diseño]

### 12.1 Tipos de archivo y tamaños [PROPOSED]
| Categoría | Formatos | Tamaño máximo | Notas |
|---|---|---|---|
| Imagen | JPEG, PNG, HEIC (convertida a JPEG en servidor), WebP | 15 MB por archivo; compresión en cliente a ≤ 2 MB / 2.000 px lado mayor para fotos de evidencia | Se conserva original si la empresa lo configura (evidencia legal). [DECISION REQUIRED] |
| Documento | PDF, DOCX, XLSX | 25 MB | Vista previa PDF en navegador. |
| Video | MP4, MOV | 200 MB | [PROPOSED — fase 2]; solo evidencia de incidentes. |
| Otros | ZIP | 50 MB | Solo con permiso; sin vista previa. |
- Validación de tipo por contenido (magic bytes), no solo por extensión. Escaneo antivirus en carga. [PROPOSED]
- Límite de almacenamiento por empresa según plan. [ASSUMPTION — modelo comercial]

### 12.2 Metadata [CONFIRMED como lista; detalle PROPOSED]
`id`, empresa, entidad relacionada (tipo + id; polimórfica), categoría/tipo de documento (catálogo), nombre original, nombre visible, MIME, tamaño, hash SHA-256 (deduplicación e integridad), fecha de carga, usuario que cargó, origen (web/móvil/API/import), fecha de emisión, fecha de expiración (si aplica), número de documento (si aplica), versión, estado (`Vigente`, `Por vencer`, `Vencido`, `Reemplazado`, `Anulado`), etiquetas, geolocalización y fecha EXIF para fotos (si disponible y la empresa lo habilita), notas.

### 12.3 Versionado [PROPOSED]
- Un documento con vencimiento (póliza, licencia, tarjeta de circulación) se **renueva** creando una nueva versión; la anterior pasa a `Reemplazado` y permanece consultable.
- Las evidencias (fotos de siniestro) **no se versionan**: se agregan; eliminar es soft delete con motivo.
- Historial de versiones visible en el detalle del documento.

### 12.4 Relación con entidades [PROPOSED]
Un documento pertenece a exactamente una entidad primaria (vehículo, conductor, despachador, póliza, orden de mantenimiento, incidente, tercero) y puede referenciarse desde otras (p. ej. factura de reparación visible desde el incidente y desde la orden).

### 12.5 Permisos [PROPOSED]
- Ver/descargar: hereda del permiso `view` sobre la entidad + categoría: documentos de identidad de personas requieren `view_pii`; facturas requieren `view_costs`.
- Cargar: `upload_evidence` sobre la entidad.
- Eliminar: `delete` sobre la entidad; nunca borrado físico inmediato (ver retención).
- Descargas se sirven por URL firmada con expiración ≤ 15 min; cada descarga queda en audit (al menos para PII y evidencias de incidentes).

### 12.6 Retención [PROPOSED] [DECISION REQUIRED — depende de normativa por país y política del cliente]
- Default: los documentos se conservan mientras la entidad exista + 5 años tras baja/cierre; configurable por empresa dentro de un rango permitido por plataforma (mín. 1 año, máx. indefinido).
- Soft delete con papelera de 30 días antes de borrado físico; evidencias de incidentes con proceso legal abierto no se purgan.
- Al terminar la suscripción: exportación completa disponible por 90 días; luego borrado certificado. [DECISION REQUIRED]

### 12.7 Auditoría
Carga, descarga, cambio de metadata, nueva versión, eliminación y restauración se registran en audit trail con usuario, fecha, IP y entidad.

---

## 13. REPORTING & EXPORTS

### 13.1 Catálogo de reportes [CONFIRMED como lista; columnas y filtros PROPOSED]

| Familia | Reporte | Filtros principales | Columnas principales |
|---|---|---|---|
| Plantilla | Conductores | Área, estatus, tipo de licencia, vigencia de licencia (rango), vehículo asignado sí/no, fecha de ingreso | Nombre, nº empleado, área, puesto, estatus, licencia, vigencia, vehículo asignado, documentos vencidos (nº) |
| Plantilla | Despachadores | Área, turno, supervisor, estatus | Nombre, área, puesto, turno, supervisor, estatus, contacto |
| Plantilla | Áreas | Activa/inactiva | Área, padre, responsables, nº conductores, nº vehículos |
| Plantilla | Cumplimiento documental de personas | Área, tipo de documento, estado | Persona, documento, nº, emisión, vencimiento, estado, días restantes |
| Vehículos | Inventario | Área, tipo, marca, estado, propiedad, año | Nº económico, placas, VIN, marca/modelo/año, tipo, área, estado, conductor, km, fecha alta |
| Vehículos | Estado de flota | Área, estado, motivo | Vehículo, estado, motivo, desde, días en estado |
| Vehículos | Seguros | Área, aseguradora, vigencia (rango), estado de póliza | Vehículo, aseguradora, nº póliza, cobertura, inicio, fin, deducible, días restantes |
| Vehículos | Documentación | Área, tipo documento, estado | Vehículo, documento, nº, emisión, vencimiento, estado |
| Vehículos | Historial de vehículo (ficha) | Vehículo, rango de fechas, tipo de evento | Timeline completo (PDF) |
| Mantenimiento | Preventivo (plan vs. real) | Área, vehículo, período, tipo | Vehículo, tipo, fecha/km previsto, fecha/km real, desvío, estado |
| Mantenimiento | Correctivo | Área, vehículo, período, taller | Vehículo, fecha, descripción, taller, costo, incidente origen |
| Mantenimiento | Costos | Período, área, vehículo, taller, tipo | Costo total, mano de obra, refacciones, costo/km, por vehículo y por tipo |
| Mantenimiento | Frecuencia | Período, tipo | Nº órdenes por vehículo/tipo; vehículos con más intervenciones |
| Siniestros | Por período | Rango, área | Folio, fecha, vehículo, conductor, tipo, severidad, estado, costo total |
| Siniestros | Por vehículo / por conductor | Vehículo/conductor, rango | Conteo, costo, severidad, tiempo medio de resolución |
| Siniestros | Por tipo / severidad / estado | Rango, área | Distribuciones y tablas cruzadas |
| Siniestros | Costos | Rango, área, aseguradora | Deducibles, cubierto por seguro, a cargo empresa, a cargo conductor, otros |
| Siniestros | Tiempo de resolución | Rango, severidad, área | Días por etapa (Reported→Review→Insurance→Repair→Resolved→Closed), mediana, p90, SLA cumplido % |
| Siniestros | Casos abiertos / envejecimiento | Área, responsable, estado | Folio, estado, días en estado, días totales, SLA restante, último movimiento |
| Transversal | Vencimientos consolidados | Rango de días (7/15/30/60/90), tipo | Entidad, tipo de vencimiento, fecha, días restantes, responsable del área |
| Transversal | Audit log | Usuario, entidad, acción, rango | Ver §16 |

### 13.2 Exportaciones [CONFIRMED: CSV, Excel, PDF]
- CSV y Excel: para listados y reportes tabulares; respeta filtros, columnas visibles y orden de la pantalla; cabeceras localizadas. [PROPOSED]
- PDF: para fichas (vehículo, conductor, incidente) y reportes de cumplimiento con logo de la empresa, fecha de corte, usuario que generó y paginación. [PROPOSED]
- Exportaciones > 5.000 filas se generan en segundo plano y se notifican con enlace de descarga (expira en 7 días). [PROPOSED]
- Permiso `export` por módulo; las exportaciones quedan en audit (quién, qué, cuántas filas, filtros). [PROPOSED] Columnas de PII y costos se excluyen si el usuario no tiene `view_pii`/`view_costs`.
- Reportes programados (envío semanal por correo): [PROPOSED — fase 2].

---

## 14. SEARCH, FILTERS & DATA DISCOVERY [PROPOSED]

### 14.1 Búsqueda global
- Caja de búsqueda en la barra superior; busca en: vehículos (nº económico, placas, VIN), conductores (nombre, nº empleado, licencia, identificación si `view_pii`), despachadores, incidentes (folio, nº reporte aseguradora), órdenes de mantenimiento (folio), pólizas (nº). Resultados agrupados por entidad, respetando permisos y alcance por área.
- Tolerancia a mayúsculas, acentos y guiones; coincidencia por prefijo y contiene.

### 14.2 Filtros avanzados por módulo
| Módulo | Filtros | Requiere búsqueda avanzada |
|---|---|---|
| Conductores | Área, estatus, tipo/vigencia de licencia, vehículo asignado, documentos vencidos, fecha ingreso, tipo de vinculación | Sí (volumen) |
| Vehículos | Área, estado, tipo, marca/modelo, año, propiedad, seguro vigente/vencido, documentos vencidos, km rango, conductor asignado | Sí |
| Mantenimiento | Estado, tipo, vehículo, mecánico/taller, fecha programada/realizada, costo rango, vencido sí/no | Sí |
| Incidentes | Estado, tipo, severidad, vehículo, conductor, área, responsable, aseguradora, fecha evento/reporte, SLA vencido, costo rango, con terceros | Sí (módulo más consultado) |
| Documentos | Entidad, tipo, estado, vencimiento rango, usuario que cargó | Sí |
| Despachadores, Áreas, Usuarios | Básicos | No |

### 14.3 Comportamientos comunes
- Ordenamiento por cualquier columna; multi-columna opcional.
- Paginación server-side (25/50/100 por página) con conteo total; scroll infinito no recomendado para tablas administrativas.
- **Filtros guardados** por usuario y compartibles a nivel empresa (p. ej. "Seguros que vencen este mes — Área Norte"). La URL refleja filtros para compartir enlaces.
- Rangos de fecha con atajos (hoy, 7 días, mes actual, trimestre, personalizado) en la zona horaria de la empresa.
- Selección de columnas visibles persistida por usuario.
- Acciones masivas sobre selección (cambiar área, exportar, asignar) con confirmación y límite de registros [PROPOSED — fase 2 salvo exportar].

---

## 15. NOTIFICATIONS & ALERTS [PROPOSED salvo lista de eventos]

### 15.1 Eventos [CONFIRMED como lista]
| Evento | Anticipación por defecto | Destinatarios por defecto | MVP |
|---|---|---|---|
| Seguro próximo a vencer | 30 / 15 / 7 / 0 días | Resp. flotilla, responsables del área | Sí |
| Documento de vehículo próximo a vencer | 30 / 15 / 7 / 0 | Resp. flotilla | Sí |
| Licencia / documento de conductor próximo a vencer | 30 / 15 / 7 / 0 | Resp. flotilla; conductor si tiene canal [fase 2] | Sí |
| Mantenimiento próximo | 15 días / 500 km | Resp. flotilla | Sí |
| Mantenimiento vencido | Diario hasta resolver (máx. 1/día) | Resp. flotilla, Supervisor | Sí |
| Siniestro nuevo | Inmediato | Resp. siniestros, Resp. flotilla, Supervisor del área | Sí |
| Cambio de estado de siniestro | Inmediato | Responsable, creador, suscriptores | Sí |
| Siniestro sin actualización | N días (default 5) | Responsable; escala a Supervisor | Sí |
| Vehículo fuera de servicio | Inmediato | Despachadores del área, Resp. flotilla | Sí |
| SLA próximo a vencer / vencido | 80 % / 100 % | Responsable; escala a Supervisor | Sí |
| Orden de mantenimiento asignada | Inmediato | Mecánico | Sí |
| Usuario creado / rol cambiado | Inmediato | Usuario afectado, Admin | Sí |
| Exportación lista | Inmediato | Solicitante | Sí |
| Resumen diario/semanal de vencimientos | Configurable | Resp. flotilla, Supervisor | Fase 2 |

### 15.2 Canales
| Canal | MVP | Notas |
|---|---|---|
| In-app (centro de notificaciones + badge) | Sí | Marcar leído, filtrar, enlace a la entidad. |
| Email | Sí | Plantillas por evento, con logo de la empresa; agrupación (digest) para evitar ruido. |
| Push (PWA / móvil) | Fase 2 | Depende de que exista app móvil o PWA instalable. [DEPENDENCY] |
| WhatsApp / SMS | Solo si existe integración futura [CONFIRMED]; requiere proveedor (p. ej. Meta Cloud API, Twilio) y plantillas aprobadas. [DEPENDENCY] | No MVP |
| Webhook | MVP (básico) | Para que el despacho u otros sistemas reaccionen (ver §18). |

### 15.3 Reglas
- Preferencias por usuario (canal y tipos) dentro de lo que la empresa permita; algunos eventos son obligatorios (p. ej. asignación de caso).
- Suscripción a entidades concretas ("seguir este siniestro / este vehículo").
- Deduplicación: una alerta por evento + entidad + umbral; si cambia la fecha de vencimiento, se reinicia el ciclo.
- Silencio nocturno configurable para canales externos.
- Registro de envío (entregado / fallido) para trazabilidad; reintentos en email y webhook.
- [RISK] Fatiga de alertas con flotas grandes; mitigación: digests, agrupación por área, umbrales configurables, priorización por severidad.

---

## 16. AUDIT TRAIL [PROPOSED salvo campos confirmados]

### 16.1 Registro
Campos [CONFIRMED]: usuario, fecha/hora (UTC + zona de empresa), acción, entidad (tipo + id + descripción legible), valor anterior, valor nuevo, IP (cuando aplique), origen (web / móvil / API key X / sistema / import), comentarios.
Adicionales [PROPOSED]: empresa, id de sesión/correlación, user-agent, resultado (éxito / denegado), motivo (cuando la acción lo exige).

### 16.2 Acciones auditables
| Dominio | Acciones |
|---|---|
| Seguridad | Login (éxito/fallo), logout, cambio de contraseña, MFA, creación/edición/desactivación de usuarios, cambios de roles y permisos, creación/revocación de API keys, impersonación de soporte. |
| Configuración | Cualquier cambio de catálogos, parámetros, workflow, SLA, retención, integraciones. |
| Datos maestros | Crear/editar/eliminar/restaurar vehículos, conductores, despachadores, áreas, mecánicos, talleres; cambios de estado; asignaciones. |
| Documentos | Carga, nueva versión, cambio de metadata, descarga (PII y evidencias), eliminación, restauración. |
| Seguros | Alta, edición, renovación, baja de pólizas. |
| Mantenimiento | Creación, asignación, cambios de estado, edición de costos, cierre, cancelación, reapertura. |
| Incidentes | Creación, cada transición, asignación, edición de cualquier campo (diff), terceros, costos, cierre, reapertura, cancelación, override de workflow. |
| Reportes | Exportaciones (filtros, filas, formato). |
| Integraciones | Llamadas de escritura vía API (quién, qué), entregas de webhooks, importaciones masivas (archivo, filas, errores). |

### 16.3 Características
- Inmutable (append-only); almacenamiento separado del transaccional; retención mínima 5 años [DECISION REQUIRED — normativa].
- Visible por entidad (pestaña "Historial/Auditoría") y como consulta global para Admin (`view_audit`), con filtros y exportación.
- Diff legible de valores para campos simples; para documentos, referencia a versión.
- Datos sensibles en "valor anterior/nuevo" se enmascaran según permisos del lector.

---

# PARTE B — SRD (System Requirements Document)

## 17. DATA MODEL

### 17.1 Principios [PROPOSED]
- **Multi-tenant por columna**: toda tabla de negocio tiene `company_id` indexado; aislamiento reforzado en capa de acceso a datos (y, de usarse PostgreSQL, con Row-Level Security). Alternativa "base de datos por tenant" descartada para MVP por costo operativo; revisable para clientes enterprise. [DECISION REQUIRED — ver §23 Scalability]
- **Identificadores**: UUID v7 como PK técnica; **folios legibles** por empresa (secuencia + prefijo) para incidentes, órdenes y, opcionalmente, vehículos.
- **Soft delete** (`deleted_at`, `deleted_by`) en entidades maestras y documentos; borrado físico solo por retención.
- **Auditoría de columnas** estándar: `created_at/by`, `updated_at/by`.
- **Dinero**: entero en unidad mínima + código de moneda ISO 4217.
- **Fechas/hora**: UTC en almacenamiento; zona horaria de empresa para presentación.
- **Catálogos**: tabla genérica `CatalogItem` (tipo, código, etiqueta, activo, orden, metadata JSON, `company_id` nullable para ítems globales semilla) para los catálogos simples; tablas propias para los que tienen relaciones (Aseguradora, Taller).
- **Campos personalizados**: `CustomFieldDefinition` (empresa, entidad, nombre, tipo, requerido, opciones) + valores en JSONB en la entidad con validación en aplicación.

### 17.2 Entidades

Lista base [CONFIRMED]: Company, User, Role, Permission, Area, Employee, Driver, Dispatcher, Vehicle, VehicleDocument, InsurancePolicy, Mechanic, Workshop, Maintenance, MaintenanceType, Incident, IncidentStatus, IncidentEvidence, ThirdParty, Repair, Notification, AuditLog. Entidades adicionales [PROPOSED] marcadas con ★.

| Entidad | Propósito | Campos principales | Relaciones | Estados | Reglas clave |
|---|---|---|---|---|---|
| **Company** | Tenant. | id, nombre legal, nombre comercial, país, zona horaria, moneda, idioma, logo, plan, estado, configuración (JSON), fecha alta | 1:N con todo | `Trial`, `Activa`, `Suspendida`, `Cerrada` | Raíz de aislamiento. |
| **User** | Identidad que accede. | id, email (único global), nombre, teléfono, hash de credencial / proveedor SSO, MFA, estado, último acceso, preferencias | N:M Company vía ★**CompanyMembership** (user, company, estado, roles, alcance de áreas) | `Invitado`, `Activo`, `Bloqueado`, `Desactivado` | Un usuario puede pertenecer a varias empresas [DECISION REQUIRED]. |
| **Role** | Conjunto de permisos. | id, company_id (null = rol de sistema), nombre, descripción, es_sistema | N:M Permission; N:M CompanyMembership | – | Roles de sistema inmutables; clonables. |
| **Permission** | Capacidad atómica. | código (`módulo:acción`), descripción, peligroso (bool) | N:M Role | – | Catálogo de código, no editable por empresa. |
| **Area** | Unidad organizativa jerárquica. | id, company_id, nombre, código, parent_id, path, activa, responsables (N:M User) | Autorreferencia; 1:N Vehicle, Employee | `Activa`, `Inactiva` | No desactivar con recursos activos. |
| **Employee** ★(generalización) | Persona de plantilla. | id, company_id, tipo (`Driver`/`Dispatcher`/`Other`), nombres, apellidos, foto, teléfono, email, tipo y nº identificación, nº empleado, área_id, puesto, fecha ingreso, fecha egreso, estatus, tipo de vinculación, supervisor_id, user_id (opcional), custom_fields | 1:N Document; 1:N VehicleAssignment (si Driver); 1:N Incident (si Driver) | `Activo`, `Inactivo`, `Suspendido`, `Baja` | Identificación única por empresa. |
| **Driver** | Subtipo de Employee. | + nº licencia, tipo licencia, vigencia licencia, categoría, observaciones, apto_para_operar (derivado) | – | – | Licencia vencida ⇒ no apto (configurable). |
| **Dispatcher** | Subtipo de Employee. | + turno, información de contacto adicional | – | – | – |
| **Vehicle** | Unidad de la flota. | id, company_id, nº económico, placas, VIN, marca, modelo, año, tipo, color, capacidad, odómetro, horómetro, estado, motivo estado, fecha alta, fecha baja, área_id, propiedad, propietario/proveedor, combustible, ubicación, mecánico_preferido_id, taller_preferido_id, external_ids (JSON), custom_fields | 1:N VehicleDocument, InsurancePolicy, VehicleAssignment, Maintenance, Incident, ★VehicleStatusHistory, ★VehiclePhotoSet | Ver §8.6 | Nº económico y placas únicos por empresa; VIN único global. |
| ★**VehicleAssignment** | Asignación conductor–vehículo. | id, vehicle_id, driver_id, tipo, inicio, fin, motivo, asignado_por | N:1 Vehicle, Driver | `Vigente`, `Finalizada` | Una `Principal` vigente por vehículo. |
| ★**VehicleStatusHistory** | Historial de estados. | id, vehicle_id, estado_anterior, estado_nuevo, motivo, referencia (incident/maintenance), fecha, usuario | N:1 Vehicle | – | Base para KPI disponibilidad. |
| ★**Document** (generaliza VehicleDocument) | Archivo con metadata. | id, company_id, entidad_tipo, entidad_id, categoría, nombre, mime, tamaño, hash, storage_key, nº documento, emisión, expiración, versión, reemplaza_a_id, estado, origen, exif (JSON), subido_por, fecha | Polimórfica a Vehicle, Employee, InsurancePolicy, Maintenance, Incident, ThirdParty | `Vigente`, `Por vencer`, `Vencido`, `Reemplazado`, `Anulado` | Estado derivado de expiración vs. umbral. |
| **VehicleDocument** | Vista/especialización de Document con entidad = Vehicle y categoría con vencimiento. | – | – | – | – |
| ★**Insurer** | Aseguradora (catálogo). | id, company_id, nombre, contacto siniestros (tel 24h, email, portal), notas | 1:N InsurancePolicy | – | – |
| **InsurancePolicy** | Póliza. | id, company_id, insurer_id, nº póliza, tipo cobertura, coberturas (JSON/checklist), inicio, fin, deducible (monto/%/moneda), prima (opcional), contacto override, documento_id, estado | N:1 Insurer; N:1 Vehicle (MVP) / N:M vía ★PolicyVehicle (fase 2) | `Vigente`, `Por vencer`, `Vencida`, `Cancelada` | Alerta por `fin`. |
| **Workshop** | Taller. | id, company_id, nombre, interno/externo, dirección, contacto, especialidades, activo | 1:N Mechanic, Maintenance | `Activo`, `Inactivo` | – |
| **Mechanic** | Mecánico. | id, company_id, nombre, workshop_id, especialidad, contacto, user_id (opcional), activo | N:1 Workshop; 1:N Maintenance | `Activo`, `Inactivo` | Puede ser externo sin usuario [DECISION REQUIRED]. |
| **MaintenanceType** | Catálogo de tipos. | id, company_id, nombre, categoría (preventivo/correctivo/inspección), checklist por defecto | 1:N Maintenance, ★MaintenancePlan | – | – |
| ★**MaintenancePlan** | Regla preventiva recurrente. | id, company_id, vehicle_id o vehicle_type, maintenance_type_id, intervalo_dias, intervalo_km, intervalo_horas, anticipación alerta, último realizado (fecha/km/h), próximo (fecha/km/h), activo | 1:N Maintenance | `Activo`, `Pausado` | "Lo que ocurra primero". |
| **Maintenance** (orden) | Trabajo concreto. | id, company_id, folio, vehicle_id, plan_id, tipo (prev/corr), maintenance_type_id, estado, fecha programada, fecha inicio, fecha fin, km, horas, mechanic_id, workshop_id, responsable_user_id, diagnóstico, trabajos (JSON/checklist), costo MO, costo refacciones, costo total, moneda, incident_id (origen), requiere_taller (bool), observaciones | 1:N ★MaintenancePart, Document; N:1 Vehicle, Mechanic, Workshop, Incident | Ver §9.3 | Responsable obligatorio. |
| ★**MaintenancePart** | Refacción usada. | id, maintenance_id, descripción, nº parte, cantidad, costo unitario, proveedor | N:1 Maintenance | – | – |
| **Incident** | Siniestro / incidente. | id, company_id, folio, tipo, severidad, estado, sub-estado "esperando a", vehicle_id, driver_id, área_id, fecha evento, fecha reporte, ubicación (texto, lat, lng), descripción, reportado_por, responsable_user_id, referencia viaje externo, vehículo operable (bool), daños (JSON), insurer_id, policy_id, nº reporte aseguradora, ajustador (nombre, contacto), fecha reporte aseguradora, resultado aseguradora, motivo rechazo, costos (deducible, reparación, cubierto, empresa, conductor, otros, moneda), legal (JSON), fecha resolución, fecha cierre, cerrado_por | 1:N IncidentEvidence (Document), ThirdParty, ★IncidentStatusTransition, ★IncidentComment, ★IncidentTask, Repair; N:1 Vehicle, Driver, InsurancePolicy | Ver §11.1 | Vehículo obligatorio. |
| **IncidentStatus** | Catálogo de estados (sistema + personalizados). | código, nombre, es_terminal, orden, aplica_a_tipos (JSON), requisitos (JSON: campos y evidencias) | 1:N IncidentStatusTransition | – | Estados de sistema no eliminables. |
| ★**IncidentStatusTransition** | Historial de transiciones. | id, incident_id, de, a, usuario, fecha, comentario, override (bool) | N:1 Incident | – | Append-only. |
| **IncidentEvidence** | Especialización de Document con entidad = Incident. | + etapa (en el lugar / taller / post-reparación), tomada_en, lat/lng | – | – | No se versiona. |
| **ThirdParty** | Tercero involucrado. | id, incident_id, tipo (persona/vehículo/propiedad), nombre, contacto, placas, aseguradora, nº póliza, daños, lesiones (bool), notas | N:1 Incident; 1:N Document | – | PII. |
| **Repair** | Vínculo incidente–orden de reparación. | id, incident_id, maintenance_id, workshop_id, fecha ingreso, fecha salida, presupuesto, costo final, notas | N:1 Incident, Maintenance | – | Costo refleja en incidente. |
| ★**IncidentTask** | Tarea pendiente dentro del caso. | id, incident_id, descripción, responsable, vence, estado | N:1 Incident | `Pendiente`, `Hecha` | – |
| **Notification** | Notificación emitida. | id, company_id, user_id, evento, entidad (tipo, id), título, cuerpo, canal, estado envío, leída_en, fecha | N:1 User | `Pendiente`, `Enviada`, `Fallida`, `Leída` | Deduplicación por clave evento+entidad+umbral. |
| ★**NotificationRule** | Configuración de alertas. | id, company_id, evento, umbrales, canales, destinatarios (roles/usuarios/responsables de área), activa | – | – | – |
| **AuditLog** | Registro inmutable. | id, company_id, user_id, api_key_id, fecha, acción, entidad (tipo, id, label), antes (JSON), después (JSON), ip, origen, user_agent, resultado, motivo, correlation_id | – | – | Append-only. |
| ★**ApiKey / WebhookEndpoint / ExternalIdMapping** | Integraciones. | key hash, scopes, empresa, estado; URL, eventos, secreto, estado, reintentos; entidad, id interno, sistema externo, id externo | – | – | Ver §18. |
| ★**ImportJob / ExportJob** | Trabajos en segundo plano. | id, company_id, tipo, archivo, estado, filas ok/err, errores (JSON), usuario, fechas | – | `Pendiente`, `Procesando`, `Completado`, `Fallido` | – |

### 17.3 Modelo de relaciones conceptual

```
Company 1──N CompanyMembership N──1 User
Company 1──N Role N──M Permission
Company 1──N Area (árbol)        Area 1──N Vehicle ; Area 1──N Employee
Employee ◄─ Driver | Dispatcher (subtipos)
Vehicle 1──N VehicleAssignment N──1 Driver
Vehicle 1──N VehicleStatusHistory
Vehicle 1──N InsurancePolicy N──1 Insurer          (fase 2: N──M vía PolicyVehicle)
Vehicle 1──N MaintenancePlan 1──N Maintenance
Maintenance N──1 Mechanic N──1 Workshop ; Maintenance 1──N MaintenancePart
Vehicle 1──N Incident N──1 Driver ; Incident N──1 InsurancePolicy
Incident 1──N ThirdParty ; Incident 1──N IncidentStatusTransition ; Incident 1──N IncidentTask
Incident 1──N Repair N──1 Maintenance
Document N──1 {Vehicle | Employee | InsurancePolicy | Maintenance | Incident | ThirdParty}  (polimórfica)
User 1──N Notification ; Company 1──N NotificationRule
Company 1──N AuditLog ; Company 1──N ApiKey ; Company 1──N WebhookEndpoint
```

---

## 18. INTEGRATIONS [PROPOSED — sección agregada; el brief la pide en objetivos pero no en estructura]

### 18.1 Principios
- OPSLOG funciona sin integración; toda integración es opt-in por empresa. [CONFIRMED]
- API pública REST (JSON) versionada (`/v1`), autenticación por API key con scopes por empresa (OAuth2 client credentials en fase 2), rate limiting por key, paginación por cursor, idempotencia en POST (`Idempotency-Key`).
- Webhooks firmados (HMAC) con reintentos exponenciales y panel de entregas.
- Importación/exportación por archivo (CSV/XLSX) con plantillas descargables y validación previa (dry-run).
- Mapeo de identificadores externos por entidad y sistema (`ExternalIdMapping`) para evitar duplicados.

### 18.2 Casos de integración con el despacho

| Caso | Dirección | Mecanismo | Prioridad |
|---|---|---|---|
| Sincronizar catálogo de vehículos y conductores | Despacho ⇄ OPSLOG | API + import inicial | MVP (import); API fase 1.5 |
| Publicar disponibilidad (estado del vehículo, aptitud del conductor) | OPSLOG → Despacho | Webhook `vehicle.status_changed`, `driver.eligibility_changed` + endpoint de consulta | MVP (webhook básico) |
| Recibir kilometraje / horas desde viajes | Despacho → OPSLOG | API `POST /vehicles/{id}/odometer` | Fase 1.5 — alimenta mantenimiento por km |
| Vincular siniestro a viaje | Despacho → OPSLOG (referencia) | Campo `external_trip_ref` + API de creación de incidente en `Draft` | Fase 2 |
| Consulta "¿puede operar?" previa a asignación | Despacho → OPSLOG | `GET /vehicles/{id}/eligibility`, `GET /drivers/{id}/eligibility` (devuelve apto/no apto + motivos) | Fase 1.5 |

- [DEPENDENCY] Definición de "dueño del dato" por entidad (§1.10). Recomendación: el despacho es dueño de la *existencia* del vehículo/conductor si ya lo tiene; OPSLOG es dueño de documentación, seguros, mantenimiento, siniestros y estado de aptitud.
- [DECISION REQUIRED] Sistema de despacho de referencia para la primera integración (si lo hay). Cualquiera sea, debe implementarse como conector sobre la API pública, no como acoplamiento en el núcleo.

### 18.3 Otras integraciones (roadmap)
| Sistema | Valor | Fase |
|---|---|---|
| Correo transaccional (SES/SendGrid/Postmark) | Notificaciones | MVP [DEPENDENCY] |
| Almacenamiento de objetos (S3/GCS/R2) | Documentos | MVP [DEPENDENCY] |
| SSO (Google Workspace, Microsoft Entra) vía OIDC/SAML | Clientes enterprise | Fase 2 |
| WhatsApp / SMS | Alertas a conductores y mecánicos externos | Fase 2 [CONFIRMED como condicional] |
| Telemetría / GPS / OBD | Odómetro automático, ubicación | Fase 3 |
| Aseguradoras (portales/API) | Reporte de siniestro automático | Fase 3; depende de cada aseguradora |
| ERP / contabilidad | Exportar costos | Fase 3 (export CSV cubre MVP) |
| Calendario (Google/Outlook) | Mantenimientos programados | Fase 3 |

### 18.4 Eventos de webhook (catálogo inicial)
`vehicle.created`, `vehicle.updated`, `vehicle.status_changed`, `driver.created`, `driver.updated`, `driver.eligibility_changed`, `incident.created`, `incident.status_changed`, `incident.closed`, `maintenance.created`, `maintenance.status_changed`, `document.expiring`, `document.expired`, `policy.expiring`, `policy.expired`.

---

## 19. BUSINESS RULES

Las reglas del brief son ejemplos; se marcan [CONFIRMED] solo las que el brief formula como afirmación; el resto es [PROPOSED].

| ID | Regla | Etiqueta | Módulo |
|---|---|---|---|
| BR-001 | Un usuario únicamente puede visualizar información de su empresa activa. | [CONFIRMED] | Seguridad |
| BR-002 | Un vehículo no puede tener dos conductores principales activos simultáneamente. | [CONFIRMED] | Vehículos |
| BR-003 | Un conductor no puede ser principal de dos vehículos simultáneamente (desactivable por configuración). | [PROPOSED] [DECISION REQUIRED] | Vehículos |
| BR-004 | Un vehículo puede estar fuera de servicio; el estado requiere motivo y queda en historial. | [CONFIRMED] + [PROPOSED] | Vehículos |
| BR-005 | Un siniestro debe estar asociado a un vehículo. | [CONFIRMED] | Siniestros |
| BR-006 | Un siniestro puede estar asociado a un conductor. | [CONFIRMED] | Siniestros |
| BR-007 | Un documento puede tener fecha de expiración; si la tiene, genera alertas y cambia de estado automáticamente. | [CONFIRMED] + [PROPOSED] | Documentos |
| BR-008 | Un mantenimiento debe registrar responsable interno. | [CONFIRMED] | Mantenimiento |
| BR-009 | Las entidades maestras y documentos usan soft delete; el borrado físico solo ocurre por política de retención. | [CONFIRMED como posibilidad] → [PROPOSED] | Transversal |
| BR-010 | Nº económico y placas son únicos por empresa; VIN único en la plataforma. | [PROPOSED] | Vehículos |
| BR-011 | Identificación personal y nº de empleado son únicos por empresa. | [PROPOSED] | Plantilla |
| BR-012 | Un conductor con licencia vencida se marca "No apto para operar"; si la empresa lo configura, pasa a `Suspendido` automáticamente. | [PROPOSED] [DECISION REQUIRED] | Plantilla |
| BR-013 | Un vehículo con seguro obligatorio vencido o documento obligatorio vencido pasa a `Restringido`; si la empresa lo configura, a `Fuera de servicio`. | [PROPOSED] [DECISION REQUIRED] | Vehículos |
| BR-014 | No se puede asignar un conductor `Inactivo`/`Baja`/`Suspendido` ni un vehículo `Baja`/`Inactivo`. | [PROPOSED] | Vehículos |
| BR-015 | El odómetro solo aumenta; una disminución requiere permiso, motivo y queda auditada. | [PROPOSED] | Vehículos |
| BR-016 | Un incidente en estado terminal es inmutable salvo reapertura con permiso y motivo. | [PROPOSED] | Siniestros |
| BR-017 | Las transiciones de workflow solo se permiten según la matriz de §11.2; el override requiere permiso específico y queda auditado. | [PROPOSED] | Siniestros |
| BR-018 | La fecha de un evento (siniestro, mantenimiento) no puede ser futura ni anterior al alta del vehículo. | [PROPOSED] | Transversal |
| BR-019 | Al crear un incidente se vincula la póliza vigente a la fecha del evento; si no existe, se alerta explícitamente. | [PROPOSED] | Siniestros |
| BR-020 | Los costos de una orden de reparación vinculada a un incidente se reflejan en el incidente; no se duplican en reportes de costo total. | [PROPOSED] | Siniestros / Mantenimiento |
| BR-021 | Un área no puede desactivarse con vehículos o personas activas asignadas. | [PROPOSED] | Áreas |
| BR-022 | Toda empresa conserva al menos un usuario activo con `manage_users` y `manage_config`. | [PROPOSED] | Seguridad |
| BR-023 | La desactivación de un usuario invalida sesiones y tokens de inmediato; sus registros históricos permanecen. | [PROPOSED] | Seguridad |
| BR-024 | Los folios de incidentes y órdenes son secuenciales por empresa y no se reutilizan, incluso si el registro se cancela. | [PROPOSED] | Transversal |
| BR-025 | Un documento con vencimiento se renueva creando una nueva versión; la anterior queda como `Reemplazado`. | [PROPOSED] | Documentos |
| BR-026 | Las exportaciones excluyen columnas de PII y costos si el usuario carece de los permisos correspondientes. | [PROPOSED] | Reportes |
| BR-027 | Importes siempre con moneda; la empresa define moneda por defecto; conversión no está en alcance. | [PROPOSED] | Transversal |
| BR-028 | Cerrar un incidente con costo a cargo de la empresa superior al umbral configurado requiere aprobación de un rol con `approve`. | [PROPOSED] [DECISION REQUIRED] | Siniestros |
| BR-029 | Un vehículo en `Baja` no puede tener asignaciones vigentes ni órdenes abiertas; la baja exige cerrarlas o cancelarlas. | [PROPOSED] | Vehículos |
| BR-030 | Un mecánico externo sin usuario no puede ser responsable interno de una orden; sí puede ser el ejecutor. | [PROPOSED] | Mantenimiento |

---

## 20. FUNCTIONAL REQUIREMENTS

Prioridad: **M** = Must (MVP), **S** = Should (fase 1.5), **C** = Could (fase 2+). Etiqueta de certeza al final de cada requerimiento cuando no es [CONFIRMED]. Actores: ADM (Admin empresa), FLT (Resp. flotilla), DSP (Despachador), SIN (Resp. siniestros), MEC (Mecánico), SUP (Supervisor), CON (Consulta), SYS (Sistema), PLT (Super-admin plataforma), EXT (sistema externo).

| ID | Módulo | Requerimiento | Prio | Actor | Dependencias |
|---|---|---|---|---|---|
| FR-001 | Plataforma | El sistema debe permitir crear una empresa (tenant) con nombre, país, zona horaria, moneda e idioma. | M | PLT | – |
| FR-002 | Plataforma | El sistema debe aislar todos los datos de negocio por empresa de modo que ninguna consulta, API o exportación devuelva datos de otra empresa. | M | SYS | FR-001 |
| FR-003 | Plataforma | El sistema debe permitir suspender una empresa, bloqueando el acceso de todos sus usuarios sin borrar datos. | M | PLT | FR-001 |
| FR-010 | Usuarios | El sistema debe permitir invitar usuarios por correo, con enlace de activación que expira en 72 h. [PROPOSED] | M | ADM | FR-001 |
| FR-011 | Usuarios | El sistema debe permitir asignar uno o más roles a un usuario dentro de la empresa. | M | ADM | FR-020 |
| FR-012 | Usuarios | El sistema debe permitir desactivar un usuario, invalidando sus sesiones activas en ≤ 60 s. [PROPOSED] | M | ADM | – |
| FR-013 | Usuarios | El sistema debe impedir desactivar o degradar al último usuario con `manage_users`. [PROPOSED] | M | SYS | FR-011 |
| FR-014 | Usuarios | El sistema debe permitir que un mismo usuario pertenezca a varias empresas y seleccione la empresa activa. [PROPOSED] [DECISION REQUIRED] | S | User | FR-002 |
| FR-020 | RBAC | El sistema debe proveer los 7 roles de sistema definidos en §5 con la matriz de permisos de §6.3 como valores por defecto. | M | SYS | – |
| FR-021 | RBAC | El sistema debe permitir clonar un rol de sistema y editar sus permisos como rol personalizado de la empresa. [PROPOSED] | M | ADM | FR-020 |
| FR-022 | RBAC | El sistema debe permitir restringir el alcance de un rol a una o más áreas (incluidas sus sub-áreas). [PROPOSED] [DECISION REQUIRED] | S | ADM | FR-040 |
| FR-023 | RBAC | El sistema debe validar permisos en backend para cada operación de UI y API; la UI oculta acciones no permitidas. | M | SYS | FR-020 |
| FR-030 | Configuración | El sistema debe permitir administrar catálogos por empresa (tipos de vehículo, documento, licencia, mantenimiento, siniestro, severidad, puestos, turnos, motivos). [PROPOSED] | M | ADM | – |
| FR-031 | Configuración | El sistema debe permitir renombrar etiquetas de campos clave por empresa. [PROPOSED] | S | ADM | – |
| FR-032 | Configuración | El sistema debe permitir definir campos personalizados tipados (texto, número, fecha, lista, booleano) en conductores, vehículos e incidentes. [PROPOSED] | S | ADM | – |
| FR-033 | Configuración | El sistema debe permitir marcar como obligatorios campos opcionales por entidad. [PROPOSED] | M | ADM | – |
| FR-034 | Configuración | El sistema debe permitir configurar umbrales de anticipación de alertas por tipo de vencimiento. [PROPOSED] | M | ADM | FR-150 |
| FR-040 | Áreas | El sistema debe permitir crear, editar, activar y desactivar áreas con estructura jerárquica de hasta 4 niveles. [PROPOSED] | M | ADM | – |
| FR-041 | Áreas | El sistema debe permitir asociar uno o más usuarios responsables a un área. | M | ADM | FR-040 |
| FR-042 | Áreas | El sistema debe impedir desactivar un área con vehículos o personas activas asignadas. [PROPOSED] | M | SYS | FR-040 |
| FR-050 | Conductores | El sistema debe permitir crear, editar, consultar y dar de baja conductores con los campos de §7.2.1. | M | FLT, ADM | FR-040 |
| FR-051 | Conductores | El sistema debe validar unicidad de identificación y nº de empleado por empresa. [PROPOSED] | M | SYS | FR-050 |
| FR-052 | Conductores | El sistema debe calcular y mostrar la aptitud para operar del conductor según vigencia de licencia y documentos obligatorios. [PROPOSED] | M | SYS | FR-050, FR-120 |
| FR-053 | Conductores | El sistema debe mostrar el vehículo asignado vigente y el historial de asignaciones del conductor. | M | FLT, DSP | FR-075 |
| FR-054 | Conductores | El sistema debe permitir importar conductores desde CSV/XLSX con plantilla, validación previa y reporte de errores por fila. [PROPOSED] | M | ADM, FLT | FR-050 |
| FR-055 | Conductores | El sistema debe restringir la visualización de identificación y documentos personales al permiso `view_pii`. [PROPOSED] | M | SYS | FR-023 |
| FR-060 | Despachadores | El sistema debe permitir gestionar despachadores con los campos de §7.2.2, incluyendo turno y supervisor. | M | FLT, ADM | FR-040 |
| FR-061 | Despachadores | El sistema debe permitir vincular opcionalmente un despachador a un usuario de la plataforma. [PROPOSED] | S | ADM | FR-010 |
| FR-070 | Vehículos | El sistema debe permitir crear, editar, consultar y dar de baja vehículos con los campos de §8.1. | M | FLT, ADM | FR-040 |
| FR-071 | Vehículos | El sistema debe validar unicidad de nº económico y placas por empresa y de VIN en la plataforma. [PROPOSED] | M | SYS | FR-070 |
| FR-072 | Vehículos | El sistema debe gestionar el estado del vehículo según §8.6, exigiendo motivo en cada cambio y registrando historial. [PROPOSED] | M | FLT | FR-070 |
| FR-073 | Vehículos | El sistema debe registrar el odómetro y rechazar valores menores al actual salvo corrección con permiso y motivo. [PROPOSED] | M | FLT, MEC | FR-070 |
| FR-074 | Vehículos | El sistema debe permitir importar vehículos desde CSV/XLSX con validación previa. [PROPOSED] | M | ADM, FLT | FR-070 |
| FR-075 | Vehículos | El sistema debe permitir asignar y desasignar conductores a vehículos con tipo (principal/secundario/temporal), fechas y motivo. | M | FLT | FR-050, FR-070 |
| FR-076 | Vehículos | El sistema debe impedir más de una asignación principal vigente por vehículo. | M | SYS | FR-075 |
| FR-077 | Vehículos | El sistema debe mostrar un historial unificado por vehículo (asignaciones, estados, mantenimientos, siniestros, documentos, pólizas) filtrable y exportable a PDF. | M | FLT, SUP | FR-072, FR-100, FR-110, FR-120, FR-090 |
| FR-078 | Vehículos | El sistema debe permitir registrar sets de fotografías por ángulo con fecha y contexto (alta, inspección, cambio de conductor). [PROPOSED] | M | FLT | FR-120 |
| FR-079 | Vehículos | El sistema debe permitir asociar mecánico y taller preferidos a un vehículo. | M | FLT | FR-095 |
| FR-080 | Vehículos | El sistema debe permitir registrar propiedad del vehículo (propio/arrendado/tercerizado) y proveedor/propietario. [PROPOSED] | S | FLT | FR-070 |
| FR-090 | Seguros | El sistema debe permitir registrar pólizas con aseguradora, nº, cobertura, inicio, fin, deducible, contacto y documento adjunto. | M | FLT | FR-070, FR-120 |
| FR-091 | Seguros | El sistema debe calcular el estado de la póliza (vigente/por vencer/vencida) y generar alertas según umbrales. | M | SYS | FR-090, FR-150 |
| FR-092 | Seguros | El sistema debe mantener un catálogo de aseguradoras por empresa con contacto de siniestros. [PROPOSED] | M | ADM, FLT | – |
| FR-093 | Seguros | El sistema debe permitir que una póliza cubra varios vehículos (póliza de flota). [PROPOSED] [DECISION REQUIRED] | C | FLT | FR-090 |
| FR-095 | Mecánicos | El sistema debe permitir gestionar talleres y mecánicos con especialidad, contacto y vínculo interno/externo. | M | FLT, ADM | – |
| FR-096 | Mecánicos | El sistema debe permitir vincular un mecánico a un usuario con rol Mecánico para que registre sus órdenes. [DECISION REQUIRED] | S | ADM | FR-010 |
| FR-100 | Mantenimiento | El sistema debe permitir definir planes preventivos por vehículo o tipo de vehículo con intervalos por días, km y/u horas. [PROPOSED] | M | FLT | FR-070 |
| FR-101 | Mantenimiento | El sistema debe generar automáticamente órdenes `Programado` cuando un plan alcance su ventana de anticipación. [PROPOSED] | M | SYS | FR-100 |
| FR-102 | Mantenimiento | El sistema debe permitir crear órdenes correctivas manualmente o desde un incidente. | M | FLT, SIN | FR-070 |
| FR-103 | Mantenimiento | El sistema debe gestionar el workflow de órdenes según §9.3 con validaciones por estado. [PROPOSED] | M | FLT, MEC | FR-102 |
| FR-104 | Mantenimiento | El sistema debe permitir registrar diagnóstico, trabajos, refacciones, costos, km, evidencias y facturas en la orden. | M | MEC, FLT | FR-103, FR-120 |
| FR-105 | Mantenimiento | El sistema debe recalcular el próximo servicio del plan al cerrar una orden preventiva. [PROPOSED] | M | SYS | FR-100, FR-103 |
| FR-106 | Mantenimiento | El sistema debe cambiar el vehículo a `En mantenimiento` al iniciar una orden que requiere taller y proponer la vuelta al estado previo al cerrar. [PROPOSED] [DECISION REQUIRED automático vs. sugerido] | M | SYS | FR-072 |
| FR-107 | Mantenimiento | El sistema debe generar alertas de mantenimiento próximo, vencido y de órdenes sin avance. | M | SYS | FR-150 |
| FR-108 | Mantenimiento | El sistema debe soportar aprobación de presupuesto antes de iniciar cuando el costo estimado supere un umbral configurado. [PROPOSED] | C | SUP | FR-103 |
| FR-110 | Siniestros | El sistema debe permitir crear incidentes con los datos de §10.2, exigiendo vehículo y tipo como mínimo en `Draft`. | M | SIN, (DSP) | FR-070 |
| FR-111 | Siniestros | El sistema debe sugerir el conductor con asignación vigente a la fecha/hora del evento y la póliza vigente a esa fecha. [PROPOSED] | M | SYS | FR-075, FR-090 |
| FR-112 | Siniestros | El sistema debe gestionar el workflow de §11 permitiendo solo transiciones válidas para el estado y rol, y bloqueando con lista de faltantes cuando no se cumplan requisitos. | M | SIN, SUP | FR-020 |
| FR-113 | Siniestros | El sistema debe registrar cada transición con usuario, fecha, comentario y mostrarla en un timeline. | M | SYS | FR-112 |
| FR-114 | Siniestros | El sistema debe permitir registrar terceros involucrados con sus datos, aseguradora y daños. | M | SIN | FR-110 |
| FR-115 | Siniestros | El sistema debe permitir adjuntar fotografías y documentos como evidencia, con etapa y fecha de captura. | M | SIN, (DSP), MEC | FR-120 |
| FR-116 | Siniestros | El sistema debe permitir registrar datos de aseguradora, nº de reporte, ajustador, resultado y motivo de rechazo. | M | SIN | FR-092 |
| FR-117 | Siniestros | El sistema debe permitir registrar costos desglosados (deducible, reparación, cubierto, empresa, conductor, otros) con moneda y restringir su visualización a `view_costs`. | M | SIN | FR-023 |
| FR-118 | Siniestros | El sistema debe permitir vincular una o más órdenes de reparación y reflejar su costo en el incidente. | M | SIN | FR-102 |
| FR-119 | Siniestros | El sistema debe permitir asignar un responsable al caso y notificarlo. | M | SIN, SUP | FR-150 |
| FR-120 | Siniestros | El sistema debe permitir cerrar un incidente solo con el checklist de cierre completo y, si aplica, aprobación. | M | SIN, SUP | FR-112 |
| FR-121 | Siniestros | El sistema debe permitir reabrir un incidente cerrado con permiso `reopen` y motivo, registrándolo en audit. | M | SUP, ADM | FR-120 |
| FR-122 | Siniestros | El sistema debe calcular SLA por severidad y emitir alertas al 80 % y 100 % con escalación. [PROPOSED] | M | SYS | FR-150 |
| FR-123 | Siniestros | El sistema debe proponer el cambio de estado del vehículo a `Fuera de servicio` cuando se marque como no operable. [PROPOSED] | M | SYS | FR-072 |
| FR-124 | Siniestros | El sistema debe permitir configurar por tipo de incidente qué estados del workflow aplican y qué evidencias se requieren por transición. [PROPOSED] | S | ADM | FR-112 |
| FR-125 | Siniestros | El sistema debe permitir crear tareas pendientes dentro del caso con responsable y fecha. [PROPOSED] | S | SIN | FR-110 |
| FR-130 | Documentos | El sistema debe permitir cargar archivos (imagen, PDF, Office) asociados a vehículos, personas, pólizas, órdenes e incidentes, con la metadata de §12.2. | M | FLT, SIN, MEC, ADM | – |
| FR-131 | Documentos | El sistema debe validar tipo por contenido, tamaño máximo por categoría y ejecutar escaneo antivirus antes de hacer disponible el archivo. [PROPOSED] | M | SYS | FR-130 |
| FR-132 | Documentos | El sistema debe calcular el estado del documento según fecha de expiración y umbrales y generar alertas. | M | SYS | FR-130, FR-150 |
| FR-133 | Documentos | El sistema debe permitir renovar un documento creando una nueva versión y conservando las anteriores. [PROPOSED] | M | FLT | FR-130 |
| FR-134 | Documentos | El sistema debe servir archivos solo mediante URLs firmadas con expiración ≤ 15 min y registrar descargas de PII y evidencias en audit. [PROPOSED] | M | SYS | FR-170 |
| FR-135 | Documentos | El sistema debe permitir capturar fotos desde la cámara del dispositivo en navegadores móviles con compresión en cliente. [PROPOSED] | M | SIN, MEC, FLT | FR-130 |
| FR-136 | Documentos | El sistema debe aplicar soft delete con papelera de 30 días y políticas de retención configurables. [PROPOSED] [DECISION REQUIRED] | S | ADM, SYS | FR-130 |
| FR-137 | Documentos | El sistema debe permitir adjuntar video como evidencia de incidentes. [PROPOSED] | C | SIN | FR-130 |
| FR-140 | Dashboard | El sistema debe mostrar los widgets de §7.1 con drill-down a listados filtrados, respetando permisos y filtro por área. | M | Todos | FR-050–FR-132 |
| FR-141 | Dashboard | El sistema debe calcular los indicadores de §2.6 que no dependan de integración. [PROPOSED] | M | SYS | FR-140 |
| FR-145 | Reportes | El sistema debe proveer los reportes de §13.1 con filtros, columnas seleccionables y ordenamiento. | M | FLT, SIN, SUP, ADM, CON | – |
| FR-146 | Reportes | El sistema debe exportar listados y reportes a CSV y Excel respetando filtros, columnas, permisos de PII y costos. | M | Todos con `export` | FR-145 |
| FR-147 | Reportes | El sistema debe exportar fichas (vehículo, conductor, incidente) y reportes de cumplimiento a PDF con logo, fecha de corte y usuario. | M | Todos con `export` | FR-145 |
| FR-148 | Reportes | El sistema debe procesar exportaciones de más de 5.000 filas en segundo plano y notificar al completarse. [PROPOSED] | M | SYS | FR-150 |
| FR-149 | Reportes | El sistema debe permitir programar el envío periódico de reportes por correo. [PROPOSED] | C | SUP | FR-146 |
| FR-150 | Notificaciones | El sistema debe generar notificaciones in-app y por correo para los eventos de §15.1 según reglas configurables por empresa. | M | SYS | – |
| FR-151 | Notificaciones | El sistema debe deduplicar alertas por evento, entidad y umbral y reiniciar el ciclo si cambia la fecha de vencimiento. [PROPOSED] | M | SYS | FR-150 |
| FR-152 | Notificaciones | El sistema debe permitir a cada usuario configurar canales y tipos de notificación dentro de lo permitido por la empresa. [PROPOSED] | M | Todos | FR-150 |
| FR-153 | Notificaciones | El sistema debe permitir seguir entidades concretas (vehículo, incidente) para recibir sus eventos. [PROPOSED] | S | Todos | FR-150 |
| FR-154 | Notificaciones | El sistema debe soportar notificaciones push (PWA). [PROPOSED] | C | SYS | FR-150 |
| FR-155 | Notificaciones | El sistema debe soportar WhatsApp/SMS mediante proveedor externo. [CONFIRMED como condicional a integración futura] | C | SYS | Proveedor |
| FR-160 | Búsqueda | El sistema debe ofrecer búsqueda global por placas, nº económico, VIN, nombre, nº empleado, licencia, folio y nº de reporte, respetando permisos. | M | Todos | – |
| FR-161 | Búsqueda | El sistema debe ofrecer filtros avanzados, ordenamiento y paginación server-side en los módulos de §14.2. | M | Todos | – |
| FR-162 | Búsqueda | El sistema debe permitir guardar filtros por usuario y compartirlos en la empresa. [PROPOSED] | S | Todos | FR-161 |
| FR-170 | Audit | El sistema debe registrar en un log inmutable las acciones de §16.2 con los campos de §16.1. | M | SYS | – |
| FR-171 | Audit | El sistema debe mostrar el historial de auditoría por entidad y una consulta global filtrable y exportable para usuarios con `view_audit`. | M | ADM, SUP | FR-170 |
| FR-180 | Integraciones | El sistema debe exponer una API REST versionada autenticada por API key con scopes por empresa para vehículos, conductores, incidentes, estados y elegibilidad. [PROPOSED] | S | EXT | FR-002 |
| FR-181 | Integraciones | El sistema debe emitir webhooks firmados para los eventos de §18.4 con reintentos y panel de entregas. [PROPOSED] | M (básico) | SYS | FR-150 |
| FR-182 | Integraciones | El sistema debe permitir mapear identificadores externos por entidad y sistema para evitar duplicados en sincronizaciones. [PROPOSED] | S | ADM, EXT | FR-180 |
| FR-183 | Integraciones | El sistema debe permitir recibir actualizaciones de odómetro vía API. [PROPOSED] | S | EXT | FR-073, FR-180 |
| FR-184 | Integraciones | El sistema debe soportar SSO (OIDC/SAML) por empresa. [PROPOSED] | C | ADM | FR-010 |
| FR-190 | Seguridad | El sistema debe soportar autenticación por contraseña con política configurable y MFA (TOTP) opcional u obligatoria por empresa. [PROPOSED] | M | Todos | – |
| FR-191 | Seguridad | El sistema debe expirar sesiones inactivas (default 8 h) y permitir cierre remoto de sesiones. [PROPOSED] | M | SYS | – |
| FR-192 | Plataforma | El sistema debe permitir al super-admin acceder a una empresa solo mediante impersonación con consentimiento registrado y audit. [PROPOSED] [DECISION REQUIRED] | S | PLT | FR-170 |

---

## 21. USER STORIES

Formato: Como [rol], quiero [acción], para [beneficio]. Criterios de aceptación en Given/When/Then (§22 amplía los de mayor riesgo).

| ID | Persona | Story | Business Value | Acceptance Criteria (resumen) | Dependencias |
|---|---|---|---|---|---|
| US-001 | Admin empresa | Como administrador, quiero invitar usuarios y asignarles roles, para que cada persona acceda solo a lo que necesita. | Control de acceso desde el día uno. | Invitación por correo; activación ≤ 72 h; roles visibles en listado; usuario sin rol no puede entrar. | FR-010, FR-011 |
| US-002 | Admin empresa | Como administrador, quiero clonar un rol y ajustar permisos, para adaptar la plataforma a la estructura de mi empresa. | Flexibilidad sin desarrollo. | Rol clonado aparece como personalizado; cambios aplican a usuarios asignados en el siguiente request; cambios en audit. | FR-021 |
| US-003 | Admin empresa | Como administrador, quiero crear áreas jerárquicas con responsables, para organizar flota y plantilla por operación. | Reportes y alertas segmentados. | Árbol de hasta 4 niveles; responsables reciben alertas del área; no se desactiva área con recursos. | FR-040–FR-042 |
| US-010 | Resp. flotilla | Como responsable de flotilla, quiero dar de alta un vehículo con sus documentos y póliza en un solo flujo, para dejarlo operativo sin omitir nada. | Onboarding completo. | Wizard de 4 pasos; documentos obligatorios configurados bloquean paso final o dejan vehículo en `Restringido`; ficha muestra todo. | FR-070, FR-090, FR-130 |
| US-011 | Resp. flotilla | Como responsable de flotilla, quiero consultar los seguros próximos a vencer, para anticipar renovaciones y evitar que vehículos operen sin cobertura. | Evita siniestros sin cobertura. | Listado filtrable por días (7/15/30/60); exportable; enlace a renovar póliza. | FR-091, FR-145 |
| US-012 | Resp. flotilla | Como responsable de flotilla, quiero renovar una póliza vencida cargando la nueva, para mantener el historial sin perder la anterior. | Trazabilidad documental. | Nueva póliza vigente; anterior `Reemplazada` y consultable; alerta de vencimiento se cancela. | FR-133 |
| US-013 | Resp. flotilla | Como responsable de flotilla, quiero asignar un conductor principal a un vehículo, para saber quién es responsable de la unidad. | Responsabilidad clara. | Rechaza segundo principal vigente; asignación anterior se cierra con fecha fin; historial en ambas fichas. | FR-075, FR-076 |
| US-014 | Resp. flotilla | Como responsable de flotilla, quiero definir un plan preventivo por km y fecha, para que el sistema me avise antes de que venza el servicio. | Mantenimiento planificado. | Plan genera orden `Programado` al entrar en ventana; alerta recibida; al cerrar, se recalcula el próximo. | FR-100, FR-101, FR-105 |
| US-015 | Resp. flotilla | Como responsable de flotilla, quiero poner un vehículo fuera de servicio con motivo, para que despacho no lo asigne. | Evita asignaciones fallidas. | Motivo obligatorio; visible para despachador en ≤ 5 s; webhook emitido si configurado. | FR-072, FR-181 |
| US-016 | Resp. flotilla | Como responsable de flotilla, quiero importar mi flota y mis conductores desde Excel, para no cargar cientos de registros a mano. | Adopción rápida. | Plantilla descargable; validación previa muestra errores por fila; importación parcial opcional; resumen final. | FR-054, FR-074 |
| US-020 | Despachador | Como despachador, quiero ver si un vehículo y un conductor están aptos para operar y por qué no, para asignar viajes sin riesgo. | Decisiones seguras en segundos. | Consulta muestra estado, motivo y vencimientos críticos; no muestra costos ni PII. | FR-052, FR-072 |
| US-021 | Despachador | Como despachador, quiero reportar un incidente en borrador con lo mínimo, para que el responsable lo complete después. | Captura temprana. | Crea `Draft` con vehículo, tipo, fecha y descripción; notifica a Resp. siniestros; no puede avanzar de estado. | FR-110 (opcional) [DECISION REQUIRED] |
| US-030 | Resp. siniestros | Como responsable de siniestros, quiero crear un siniestro desde el móvil adjuntando fotos en el lugar, para no perder evidencia. | Evidencia completa. | Formulario responsive; cámara nativa; fotos con fecha/hora y geolocalización si está permitida; funciona con conexión intermitente (reintento de carga). | FR-110, FR-115, FR-135 |
| US-031 | Resp. siniestros | Como responsable de siniestros, quiero que el sistema me muestre la póliza vigente a la fecha del evento, para reportar a la aseguradora correcta. | Reduce rechazos. | Póliza precargada; si no hay, alerta "sin cobertura" visible y registrada. | FR-111 |
| US-032 | Resp. siniestros | Como responsable de siniestros, quiero avanzar el caso por estados con requisitos claros, para no cerrar casos incompletos. | Calidad del proceso. | Solo transiciones válidas; faltantes listados; cada transición en timeline. | FR-112, FR-113 |
| US-033 | Resp. siniestros | Como responsable de siniestros, quiero registrar el rechazo de la aseguradora y decidir si apelar o asumir, para dejar documentada la decisión y su costo. | Trazabilidad financiera. | Estado `Insurance Rejected` con motivo y documento; apelación o asunción con aprobación si supera umbral. | FR-112, FR-117 |
| US-034 | Resp. siniestros | Como responsable de siniestros, quiero vincular la orden de reparación al siniestro, para ver el costo total del evento en un solo lugar. | Costo real del siniestro. | Orden vinculada; costo reflejado; estado `Repair` habilitado; cierre requiere orden completada. | FR-118 |
| US-035 | Resp. siniestros | Como responsable de siniestros, quiero recibir alerta cuando un caso lleva días sin movimiento, para que nada se olvide. | Reduce tiempo de cierre. | Alerta a N días; escalación a Supervisor a 2N; configurable. | FR-122 |
| US-040 | Mecánico | Como mecánico, quiero ver mis órdenes asignadas y registrar lo realizado desde el taller, para no depender de papel. | Datos de mantenimiento confiables. | Lista de órdenes propias; registro de trabajos, refacciones, km, fotos; estado `Completado`; no ve otros módulos. | FR-103, FR-104 |
| US-041 | Mecánico | Como mecánico, quiero consultar el historial de servicios del vehículo, para diagnosticar mejor. | Mejor diagnóstico. | Historial de órdenes del vehículo visible desde la orden. | FR-077 |
| US-050 | Supervisor | Como supervisor, quiero un dashboard con vencimientos, siniestros abiertos y disponibilidad por área, para detectar problemas sin pedir reportes. | Visibilidad gerencial. | Widgets con drill-down; filtro por área; datos actualizados ≤ 5 min. | FR-140, FR-141 |
| US-051 | Supervisor | Como supervisor, quiero aprobar cierres de siniestro con costo alto, para controlar el gasto. | Control financiero. | Cierre bloqueado hasta aprobación cuando costo > umbral; aprobación en audit. | FR-120, BR-028 |
| US-052 | Supervisor | Como supervisor, quiero exportar el reporte de siniestros por período y vehículo a Excel, para presentarlo a dirección. | Reporte sin planillas. | Export respeta filtros; incluye costos solo con `view_costs`; > 5.000 filas en segundo plano. | FR-146, FR-148 |
| US-060 | Usuario de consulta | Como auditor del cliente, quiero ver solo los vehículos y conductores del área asignada a mi contrato con su cumplimiento documental, para verificar sin acceder a otros datos. | Confianza del cliente. | Alcance por área; sin costos ni PII; export PDF de cumplimiento. | FR-022, FR-147 |
| US-070 | Admin empresa | Como administrador, quiero ver quién cambió qué y cuándo en un siniestro, para resolver disputas internas. | Trazabilidad. | Audit por entidad con diff; filtro por usuario y fecha; exportable. | FR-170, FR-171 |
| US-080 | Sistema externo | Como sistema de despacho, quiero consultar la elegibilidad de un vehículo y recibir webhooks de cambios de estado, para no asignar unidades no aptas. | Integración de valor inmediato. | Endpoint devuelve apto/no apto + motivos en ≤ 300 ms p95; webhook firmado entregado con reintentos. | FR-180, FR-181 |
| US-081 | Admin empresa | Como administrador, quiero generar una API key con permisos limitados y ver sus entregas de webhook, para integrar con mi despacho de forma segura. | Integración autogestionada. | Key con scopes; revocable; panel de entregas con reintento manual. | FR-180, FR-181 |

---

## 22. ACCEPTANCE CRITERIA (detalle para QA)

Se detallan los criterios de las historias de mayor riesgo. QA debe derivar casos positivos, negativos y de borde de cada uno.

**US-013 — Asignación de conductor principal**
- Given un vehículo V con asignación principal vigente al conductor A, When el usuario intenta asignar al conductor B como principal sin cerrar la anterior, Then el sistema rechaza con mensaje que identifica a A y ofrece "reemplazar" (cierra A con fecha-hora actual y crea B).
- Given un conductor B con estatus `Baja`, When se intenta asignarlo, Then el sistema rechaza indicando el estatus.
- Given una asignación creada, When se consulta la ficha del vehículo y la del conductor, Then ambas muestran la asignación vigente y la anterior en historial con fechas.

**US-011 — Seguros próximos a vencer**
- Given una póliza con fecha fin = hoy + 20 días y umbral de 30 días, When se abre el listado "por vencer en 30 días", Then la póliza aparece con "20 días restantes".
- Given la misma póliza y filtro de 15 días, When se aplica, Then no aparece.
- Given una póliza vencida ayer, When se abre el dashboard, Then el widget "Seguros vencidos" la cuenta y el vehículo muestra estado `Restringido` si la regla está activa.

**US-014 — Plan preventivo por km y fecha**
- Given un plan cada 10.000 km o 180 días con último servicio a 50.000 km el 1 de enero, y odómetro actual 59.600 km el 1 de marzo, When el job diario evalúa planes con anticipación de 500 km, Then se crea una orden `Programado` y se notifica al responsable de flotilla una sola vez.
- Given la orden anterior en `Programado`, When el job vuelve a ejecutarse, Then no crea una segunda orden para el mismo plan.
- Given la orden cerrada con km 60.100 el 10 de marzo, When se consulta el plan, Then el próximo es 70.100 km o 6 de septiembre (lo que ocurra primero).

**US-030 — Siniestro desde móvil con fotos**
- Given un usuario con `incidents:create` en un navegador móvil, When toca "Agregar foto", Then se abre la cámara nativa y la foto se comprime a ≤ 2 MB antes de subir.
- Given pérdida de conexión durante la carga de 3 fotos, When la conexión se restablece dentro de la sesión, Then las cargas pendientes se reintentan automáticamente y el usuario ve el estado de cada una.
- Given una foto cargada, When se consulta su metadata, Then muestra fecha/hora de captura, usuario, etapa y hash.

**US-032 — Workflow con requisitos**
- Given un incidente en `Under Review` sin número de reporte de aseguradora, When el usuario intenta pasar a `Insurance Process`, Then la transición se bloquea y la UI lista "Número de reporte", "Aseguradora", "Fecha de reporte" como faltantes.
- Given un usuario con rol Despachador, When abre un incidente en `Reported`, Then no ve botones de transición.
- Given un incidente en `Closed`, When un usuario con `reopen` lo reabre con motivo, Then el estado pasa a `Reopened`, el timeline y el audit registran el motivo, y los campos vuelven a ser editables.
- Given un incidente en `Closed`, When un usuario sin `reopen` intenta adjuntar evidencia, Then el sistema lo impide e indica que requiere reapertura.

**US-033 — Rechazo de aseguradora**
- Given un incidente en `Insurance Process`, When se registra resultado "Rechazado" con motivo y documento, Then el estado pasa a `Insurance Rejected` y se notifica al Supervisor del área.
- Given `Insurance Rejected` y costo a cargo de la empresa > umbral configurado, When el responsable elige "Asumir y reparar", Then el sistema crea una solicitud de aprobación y no permite avanzar a `Repair` hasta que un usuario con `approve` la apruebe.

**US-020 — Elegibilidad para despachador**
- Given un conductor con licencia vencida hace 2 días, When el despachador lo consulta, Then ve "No apto — Licencia vencida (fecha)" y no ve el número de identificación.
- Given un vehículo en `En mantenimiento`, When el despachador lo consulta, Then ve el estado, el motivo y la fecha estimada de salida si existe.

**US-016 — Importación masiva**
- Given un archivo con 300 filas de las cuales 12 tienen placas duplicadas o fechas inválidas, When se ejecuta la validación previa, Then el sistema muestra 12 errores con fila, columna y motivo y no crea ningún registro.
- Given el mismo archivo y opción "importar válidas", When se confirma, Then se crean 288 vehículos, se genera un reporte descargable de los 12 errores y el audit registra la importación.

**US-080 — API de elegibilidad y webhooks**
- Given una API key con scope `vehicles:read` de la empresa X, When consulta `/v1/vehicles/{id}/eligibility` de un vehículo de la empresa Y, Then recibe 404 (no 403, para no revelar existencia).
- Given un cambio de estado de vehículo, When el webhook endpoint responde 500, Then el sistema reintenta con backoff (1 min, 5 min, 30 min, 2 h, 12 h) y marca la entrega como fallida tras el 5.º intento, visible en el panel.
- Given un webhook recibido, When el receptor valida la firma HMAC con el secreto, Then la firma coincide para el cuerpo exacto enviado.

**FR-002 — Aislamiento multi-tenant (transversal, prioridad máxima para QA)**
- Given un usuario de la empresa X autenticado, When manipula el id de un recurso en la URL o API para apuntar a un recurso de la empresa Y, Then recibe 404 y el intento queda en audit como "denegado".
- Given una exportación de la empresa X, When se inspecciona el archivo, Then no contiene ninguna fila de otra empresa.
- Given un usuario con membresía en X e Y, When tiene activa X, Then la búsqueda global no devuelve resultados de Y.

---

## 23. NON-FUNCTIONAL REQUIREMENTS

Todos los valores numéricos son [PROPOSED] salvo indicación; deben validarse con Arquitectura y DevOps y ajustarse al plan comercial.

### 23.1 Performance
| ID | Requisito |
|---|---|
| NFR-P1 | Tiempo de respuesta p95 ≤ 500 ms para lecturas de listados paginados (≤ 100 filas) y detalles; ≤ 1 s para dashboard. |
| NFR-P2 | Escrituras transaccionales p95 ≤ 800 ms (sin contar carga de archivos). |
| NFR-P3 | Carga de archivo de 10 MB completada en ≤ 10 s en conexión 4G; carga directa a almacenamiento de objetos con URL prefirmada (no pasa por el backend). |
| NFR-P4 | Búsqueda global p95 ≤ 700 ms sobre 1 M de registros por empresa. |
| NFR-P5 | Concurrencia: 500 usuarios concurrentes por región sin degradación > 20 % en p95; 50 por empresa típica. |
| NFR-P6 | Exportaciones ≤ 5.000 filas sincrónicas en ≤ 10 s; mayores en segundo plano. |
| NFR-P7 | Jobs de evaluación de vencimientos/SLA completan en ≤ 15 min para 10.000 empresas × 500 vehículos. |

### 23.2 Availability
| ID | Requisito |
|---|---|
| NFR-A1 | Disponibilidad objetivo 99,5 % mensual en MVP; 99,9 % para plan enterprise [DECISION REQUIRED — SLA comercial]. |
| NFR-A2 | Despliegues sin downtime (rolling / blue-green). |
| NFR-A3 | Degradación elegante: si el servicio de notificaciones o antivirus cae, la operación principal continúa y se encola el trabajo. |
| NFR-A4 | Ventanas de mantenimiento anunciadas con 72 h, fuera de horario operativo de la mayoría de los tenants. |

### 23.3 Security
| ID | Requisito |
|---|---|
| NFR-S1 | Autenticación: contraseña con política (≥ 12 caracteres, verificación contra listas de filtraciones), bloqueo progresivo tras intentos fallidos, MFA TOTP opcional/obligatoria por empresa; SSO OIDC/SAML en fase 2. |
| NFR-S2 | Autorización: RBAC evaluado en backend en cada request; filtrado por `company_id` en capa de datos (RLS si PostgreSQL); pruebas automatizadas de aislamiento en CI. |
| NFR-S3 | Cifrado: TLS 1.2+ en tránsito; cifrado en reposo en base de datos y almacenamiento de objetos; campos de PII sensible (nº identificación) cifrados a nivel de aplicación [DECISION REQUIRED — impacto en búsqueda]. |
| NFR-S4 | Secretos: gestor de secretos (no en código ni variables planas); rotación de API keys y secretos de webhook por el administrador; hashes de API keys, nunca en claro. |
| NFR-S5 | Sesiones: tokens de corta vida con refresh; expiración por inactividad 8 h (configurable); revocación inmediata al desactivar usuario; cookies `HttpOnly`, `Secure`, `SameSite`. |
| NFR-S6 | Archivos: URLs firmadas ≤ 15 min; validación por magic bytes; antivirus; sin ejecución de contenido; cabeceras `Content-Disposition` seguras. |
| NFR-S7 | OWASP ASVS nivel 2 como referencia; pruebas de penetración antes de GA y anuales; dependencias escaneadas en CI. |
| NFR-S8 | Rate limiting por IP, usuario y API key; protección contra enumeración (404 uniforme para recursos ajenos). |
| NFR-S9 | Registro de seguridad (logins, fallos, cambios de permisos) exportable a SIEM del cliente en plan enterprise [fase 2]. |

### 23.4 Privacy
| ID | Requisito |
|---|---|
| NFR-PR1 | Datos personales de empleados (identificación, licencia, foto, documentos, contacto) se tratan como PII: acceso por permiso `view_pii`, descargas auditadas, minimización en exportaciones. |
| NFR-PR2 | Cumplimiento de las normativas de protección de datos personales de cada país donde se comercialice (los países objetivo no están definidos en el brief [DECISION REQUIRED]; la terminología sugiere México como primer mercado, cuya norma es la LFPDPPP); acuerdo de tratamiento de datos entre plataforma y empresa cliente (la empresa es responsable; la plataforma, encargada). [DEPENDENCY — Legal] |
| NFR-PR3 | Derechos ARCO/titulares: capacidad de exportar y anonimizar los datos de una persona a solicitud de la empresa (anonimización preserva estadísticas de siniestros sin identificar). [PROPOSED] |
| NFR-PR4 | Fotografías de siniestros pueden contener terceros y lesiones: acceso restringido al módulo; sin uso secundario; retención según §12.6. |
| NFR-PR5 | Información de seguros (pólizas, deducibles, costos): permiso `view_costs`; no visible para despachadores ni consulta por defecto. |
| NFR-PR6 | Super-admin de plataforma sin acceso a datos operativos salvo impersonación consentida y auditada. [DECISION REQUIRED] |
| NFR-PR7 | Residencia de datos: una región por defecto (a definir); clientes enterprise podrían requerir región específica. [DECISION REQUIRED] |

### 23.5 Scalability
| ID | Requisito |
|---|---|
| NFR-SC1 | Dimensionamiento de diseño a 3 años: 1.000 empresas; 50.000 usuarios; 200.000 vehículos; 500.000 personas; 20 M documentos (≈ 40 TB); 2 M incidentes; 10 M órdenes. [ASSUMPTION] |
| NFR-SC2 | Multi-tenant por columna con índices compuestos por `company_id`; particionamiento de audit log y notificaciones por fecha. |
| NFR-SC3 | Escalado horizontal de API y workers; base de datos con réplicas de lectura para reportes. |
| NFR-SC4 | Posibilidad de aislar un tenant grande en base de datos dedicada sin cambiar el código de aplicación (abstracción de conexión por tenant). [DECISION REQUIRED — costo de diseño inicial] |
| NFR-SC5 | Límites por plan (vehículos, usuarios, almacenamiento) aplicados en aplicación con avisos previos. [ASSUMPTION — modelo comercial] |

### 23.6 Maintainability
| ID | Requisito |
|---|---|
| NFR-M1 | Logging estructurado (JSON) con `company_id`, `user_id`, `correlation_id`; niveles por entorno; sin PII en logs. |
| NFR-M2 | Monitoreo: métricas de latencia, errores, saturación por servicio; alertas de SLO; dashboards operativos. |
| NFR-M3 | Observabilidad: trazas distribuidas en API y workers; health checks; seguimiento de colas (notificaciones, webhooks, exportaciones, jobs de vencimiento). |
| NFR-M4 | Documentación: OpenAPI para la API pública; ADRs para decisiones de arquitectura; runbooks de operación; guía de onboarding de tenant. |
| NFR-M5 | Calidad: cobertura de pruebas en reglas de negocio y workflow ≥ 80 %; pruebas de aislamiento multi-tenant obligatorias en CI; pruebas E2E de flujos críticos (alta vehículo, siniestro completo, mantenimiento completo). |
| NFR-M6 | Feature flags por empresa para despliegue progresivo de módulos. |
| NFR-M7 | Internacionalización desde el inicio (español por defecto; otros idiomas según mercados objetivo [DECISION REQUIRED]); formatos de fecha/moneda por empresa. |

### 23.7 Backup & Recovery
| ID | Requisito |
|---|---|
| NFR-B1 | Backups automáticos de base de datos: snapshot diario + PITR continuo; retención 35 días; copias en región secundaria. |
| NFR-B2 | Almacenamiento de objetos con versionado y replicación entre zonas; borrado lógico antes de físico. |
| NFR-B3 | RPO ≤ 15 min; RTO ≤ 4 h para MVP; RPO ≤ 5 min / RTO ≤ 1 h para enterprise. [DECISION REQUIRED — SLA comercial] |
| NFR-B4 | Pruebas de restauración trimestrales documentadas. |
| NFR-B5 | Exportación completa de datos de un tenant (JSON/CSV + archivos) bajo demanda y al terminar el contrato. |
| NFR-B6 | Plan de recuperación ante desastres con roles, runbook y comunicación a clientes. |

---

## 24. UX/UI REQUIREMENTS [PROPOSED]

### 24.1 Principios [CONFIRMED como lista; interpretación PROPOSED]
- **Desktop-first para administración**: layouts de tablas densas, panel lateral, atajos; pensado para jornadas de varias horas.
- **Responsive**: los flujos de campo (crear incidente, adjuntar fotos, registrar servicio, consultar elegibilidad) deben funcionar completos en móvil (≥ 360 px). El resto, usable en tablet.
- **Accesibilidad**: WCAG 2.1 AA; navegación por teclado completa en tablas y formularios; contraste; etiquetas; estados no solo por color (badges con texto/ícono).
- **Consistencia**: sistema de diseño con componentes reutilizables (tabla, formulario, badge de estado, timeline, visor de documentos, galería); mismo patrón de listado → detalle → edición en todos los módulos.
- **Progressive disclosure**: formularios con lo esencial visible y secciones avanzadas colapsadas; wizards para altas complejas; detalle con pestañas.
- **Grandes volúmenes**: paginación server-side, columnas configurables, filtros persistentes, acciones masivas, búsqueda con tolerancia, estados de carga esqueléticos, exportación en segundo plano.
- **Cero ambigüedad de estado**: cada entidad muestra su estado y "por qué" (motivo, vencimiento) en el mismo lugar siempre.
- **Multi-empresa visible**: nombre y logo de la empresa activa siempre en pantalla; cambio de empresa explícito.

### 24.2 Componentes clave
| Componente | Uso | Requisitos |
|---|---|---|
| Navegación principal / Sidebar | Módulos por permiso; colapsable; sección "Configuración" al final; badge de notificaciones. | Agrupación: Inicio · Plantilla (Conductores, Despachadores, Áreas) · Flota (Vehículos, Seguros, Documentos) · Mantenimiento · Siniestros · Reportes · Configuración. |
| Dashboard | Grid de widgets con drill-down. | Filtro global por área y período; estados vacíos útiles ("No hay vencimientos en 30 días"). |
| Tablas | Listados. | Ordenamiento, filtros en panel lateral, chips de filtros activos, selección múltiple, columnas configurables, densidad, export, 25/50/100 filas, URL con estado. |
| Detail pages | Ficha de vehículo, conductor, incidente, orden. | Cabecera con identificador, estado (badge), acciones principales; pestañas: Resumen · Documentos · Historial · Auditoría + específicas (Seguros, Mantenimiento, Siniestros, Terceros, Costos). |
| Forms | Alta/edición. | Validación en línea y al enviar; mensajes específicos; autoguardado de borradores en incidentes; campos obligatorios marcados según configuración; etiquetas configurables. |
| Modals | Confirmaciones y acciones cortas (cambiar estado, asignar). | Motivo obligatorio cuando aplica; nunca para formularios largos. |
| Wizards | Alta de vehículo (datos → documentos → seguro → fotos), alta de incidente (evento → involucrados → evidencia → seguro), onboarding de empresa. | Guardado por paso; resumen final; posibilidad de completar luego. |
| Timeline | Historial de vehículo, conductor, incidente, orden. | Íconos por tipo de evento, filtro por tipo, autor y fecha, enlaces a documentos; carga incremental. |
| Status badges | Todos los estados. | Color + texto + ícono; tooltip con motivo y desde cuándo; paleta única en todo el producto. |
| Document viewer | PDF e imágenes. | Vista previa en panel/modal, zoom, rotación, descarga (con permiso), metadata lateral, versiones. |
| Photo gallery | Fotos de vehículo y evidencias. | Miniaturas por ángulo/etapa, lightbox, comparación antes/después, captura desde cámara en móvil, carga múltiple con progreso y reintento. |
| Centro de notificaciones | Campana + página. | Agrupadas por tipo, marcar leídas, enlace directo, preferencias. |
| Búsqueda global | Barra superior. | Resultados agrupados por entidad con atajo de teclado (`/`). |

### 24.3 Estados de pantalla obligatorios
Cada listado y detalle define: carga, vacío (con acción sugerida), error (con reintento), sin permiso, y datos parciales (p. ej. "Sin póliza vigente" destacado en rojo en la ficha del vehículo).

---

## 25. KEY SCREENS

| # | Pantalla | Objetivo | Información | Acciones | Permisos | Estados | Validaciones |
|---|---|---|---|---|---|---|---|
| S01 | Login / MFA / Selección de empresa | Autenticar y elegir tenant. | Email, contraseña, código MFA; lista de empresas del usuario. | Entrar, recuperar contraseña, SSO (fase 2), elegir empresa. | Público. | Error de credenciales genérico; bloqueo progresivo; empresa suspendida. | Formato email; política de contraseña en cambio. |
| S02 | Dashboard | Visión del estado operativo. | Widgets §7.1; filtros área/período. | Drill-down; cambiar filtros; ir a notificaciones. | `dashboard:view`; widgets según permisos. | Carga, vacío, sin datos por filtro. | – |
| S03 | Empresas (plataforma) | Administrar tenants. | Lista de empresas, plan, estado, uso. | Crear, suspender, impersonar (con consentimiento). | Super-admin. | – | Datos de empresa obligatorios. |
| S04 | Usuarios | Gestionar accesos. | Lista: nombre, email, roles, áreas, estado, último acceso. | Invitar, editar roles, desactivar, reenviar invitación, cerrar sesiones. | `manage_users`. | Invitado, activo, bloqueado, desactivado. | Email único; no quitar último admin. |
| S05 | Roles y permisos | Configurar RBAC. | Roles de sistema y personalizados; matriz módulo × acción. | Clonar, editar, asignar alcance por área, eliminar personalizado sin usuarios. | `manage_config`. | – | Advertencia en permisos peligrosos. |
| S06 | Áreas | Estructura organizativa. | Árbol; responsables; conteo de recursos. | Crear, editar, mover, activar/desactivar, asignar responsables. | `areas:*`. | Activa/inactiva. | No desactivar con recursos; profundidad ≤ 4. |
| S07 | Conductores (listado) | Encontrar y gestionar conductores. | Tabla con columnas configurables; aptitud; vencimientos. | Crear, importar, exportar, filtrar, abrir ficha. | `drivers:view/create/export`. | Vacío, filtrado. | – |
| S08 | Conductor (detalle) | Ficha completa. | Pestañas: Resumen · Licencia y documentos · Vehículo asignado · Siniestros · Historial · Auditoría. | Editar, cambiar estatus, cargar documento, asignar vehículo. | `drivers:edit`, `view_pii` para identificación/documentos. | Activo/Inactivo/Suspendido/Baja; apto/no apto. | Unicidad identificación; licencia con vigencia. |
| S09 | Despachadores | Gestionar plantilla de despacho. | Tabla; turno; supervisor. | CRUD; vincular a usuario. | `dispatchers:*`. | Activo/inactivo. | – |
| S10 | Vehículos (listado) | Encontrar y gestionar flota. | Tabla; estado; seguro; documentos vencidos; conductor. | Crear (wizard), importar, exportar, filtros, acciones masivas (cambiar área). | `vehicles:*`. | Vacío, filtrado. | – |
| S11 | Vehículo (detalle) | Ficha única del vehículo. | Cabecera (nº económico, placas, estado, conductor); pestañas: Resumen · Documentos · Seguros · Fotos · Mantenimiento · Siniestros · Historial · Auditoría. | Editar, cambiar estado (modal con motivo), asignar conductor, cargar documento/póliza/foto, crear orden, crear incidente. | Por pestaña: `vehicles:edit`, `insurance:view`, `view_costs`, etc. | Según §8.6; indicadores "sin póliza vigente", "documento vencido". | Odómetro no decreciente; unicidad. |
| S12 | Alta de vehículo (wizard) | Dejar un vehículo operativo. | Pasos: datos → documentos → seguro → fotos → resumen. | Guardar por paso; finalizar; completar luego. | `vehicles:create`. | Borrador; completo; restringido por faltantes. | Obligatorios configurados. |
| S13 | Seguros | Vista transversal de pólizas. | Tabla por vehículo/aseguradora/vigencia. | Renovar, editar, exportar. | `insurance:*`, `view_costs` para deducible. | Vigente/por vencer/vencida. | Fechas coherentes. |
| S14 | Mantenimiento (listado + calendario) | Planificar y seguir órdenes. | Tabla de órdenes; vista calendario por fecha programada; planes. | Crear orden, asignar, cambiar estado, filtrar, exportar; gestionar planes. | `maintenance:*`. | §9.3. | – |
| S15 | Orden de mantenimiento (detalle) | Ejecutar y cerrar un servicio. | Vehículo, plan, estado, mecánico/taller, diagnóstico, trabajos, refacciones, costos, evidencias, facturas, timeline. | Transiciones; registrar trabajos; cargar evidencia; vincular incidente. | `maintenance:edit`; mecánico solo las propias; costos con `view_costs`. | §9.3. | BR-M2, BR-M5. |
| S16 | Mis órdenes (vista mecánico, móvil) | Trabajo del día del mecánico. | Lista simplificada; detalle con checklist. | Iniciar, registrar, completar, foto. | Rol Mecánico. | Asignado/En proceso/Completado. | Km, trabajos. |
| S17 | Siniestros (listado) | Seguimiento de casos. | Tabla: folio, fecha, vehículo, conductor, tipo, severidad, estado, responsable, días en estado, SLA. Vistas guardadas ("Mis casos", "Críticos", "Sin movimiento"). | Crear, asignar, filtrar, exportar. | `incidents:*`. | §11.1. | – |
| S18 | Siniestro (detalle) | Gestionar el caso completo. | Cabecera (folio, estado, severidad, SLA); pestañas: Resumen · Involucrados y terceros · Evidencia · Seguro · Reparación · Costos · Tareas · Timeline · Auditoría. Panel de "siguiente paso" con faltantes. | Transiciones válidas; editar; adjuntar; asignar; crear orden; cerrar; reabrir. | Según §6.3; costos con `view_costs`. | §11.1; bloqueado si cerrado. | §11.2 requisitos por estado. |
| S19 | Nuevo siniestro (wizard, móvil-first) | Captura rápida y completa. | Evento → vehículo/conductor (sugeridos) → terceros → evidencia (cámara) → seguro (precargado) → resumen. | Guardar borrador; reportar. | `incidents:create`. | Draft/Reported. | BR-I3, BR-I4. |
| S20 | Configuración de workflow | Adaptar estados, requisitos, SLA. | Estados por tipo; evidencias requeridas por transición; SLA por severidad; aprobaciones. | Editar; previsualizar diagrama. | `manage_config`. | – | Estados de sistema no eliminables. |
| S21 | Documentos | Vista transversal. | Tabla por entidad/tipo/estado/vencimiento; papelera. | Cargar, renovar, descargar, eliminar, restaurar. | Según entidad; `view_pii`, `view_costs`. | §12.2. | Tipo/tamaño. |
| S22 | Reportes | Generar y exportar. | Catálogo §13.1; filtros; vista previa; historial de exportaciones. | Ejecutar, exportar CSV/XLSX/PDF, guardar filtros, programar (fase 2). | `reports:view/export`. | Generando en segundo plano. | – |
| S23 | Notificaciones | Centro y preferencias. | Lista agrupada; preferencias por canal/evento. | Marcar leídas; configurar. | Todos. | – | – |
| S24 | Configuración de empresa | Parámetros y catálogos. | Identidad, etiquetas, catálogos, campos personalizados, obligatoriedad, alertas, numeración, retención. | Editar. | `manage_config`. | – | Coherencia de catálogos en uso (no eliminar ítems referenciados; solo desactivar). |
| S25 | Integraciones | API keys y webhooks. | Keys (scopes, último uso), endpoints, entregas, mapeos. | Crear/revocar key; crear endpoint; reintentar entrega; probar. | `manage_config`. | Entregas: ok/fallida/pendiente. | URL https; secreto. |
| S26 | Auditoría | Consulta global. | Tabla con filtros por usuario, entidad, acción, fecha; diff. | Filtrar; exportar. | `view_audit`. | – | – |
| S27 | Importaciones | Carga masiva. | Plantillas; historial de jobs; errores por fila. | Subir, validar, importar, descargar errores. | `*:create` del módulo. | Pendiente/validado/importado/fallido. | Esquema de plantilla. |

---

## 26. FINAL PRODUCT SUMMARY

### 26.1 Qué estamos construyendo
Una plataforma web B2B multi-tenant de bitácoras operativas que centraliza plantilla, vehículos, documentación, seguros, mantenimiento, siniestros con workflow, evidencias, reportes y trazabilidad, concebida como complemento del sistema de despacho que cada cliente ya tiene. [CONFIRMED]

### 26.2 Para quién
Empresas de transporte corporativo, transporte de personal, logística, servicios industriales y cualquier operación con vehículos asignados, con flota propia o tercerizada, de 10 a 500+ vehículos, que ya despachan con otro sistema. Usuarios: administradores, responsables de flotilla, despachadores, responsables de siniestros, mecánicos, supervisores y usuarios de consulta.

### 26.3 Qué problema resuelve
Información dispersa, vencimientos no detectados, vehículos operando sin cobertura o mantenimiento, siniestros sin proceso ni evidencia, falta de trazabilidad y reportería manual.

### 26.4 Módulos principales
Configuración y RBAC · Áreas · Plantilla (conductores, despachadores) · Vehículos (documentos, seguros, fotos, historial) · Mantenimiento · Siniestros y workflow · Documentos y evidencias · Dashboard · Reportes y exportaciones · Búsqueda · Notificaciones · Audit trail · API, webhooks e importación.

### 26.5 Qué entra en MVP [PROPOSED — a validar por el negocio]
- Multi-tenant, usuarios, 7 roles de sistema + roles personalizados (sin alcance por área).
- Áreas jerárquicas.
- Conductores, despachadores, vehículos con importación CSV/XLSX.
- Documentos con vencimiento, versiones, fotos por ángulo; captura desde móvil (web responsive).
- Seguros 1:N por vehículo; catálogo de aseguradoras.
- Mecánicos y talleres; planes preventivos por fecha/km; órdenes con workflow, costos, refacciones, evidencias, facturas.
- Siniestros con workflow completo (§11), terceros, costos, reparación vinculada, SLA y escalaciones básicas.
- Dashboard, reportes de §13.1 con export CSV/XLSX/PDF.
- Notificaciones in-app y email; webhooks básicos.
- Búsqueda global, filtros avanzados, filtros guardados.
- Audit trail completo.
- Seguridad base: contraseña + MFA opcional, URLs firmadas, antivirus, RLS.

### 26.6 Qué queda fuera (del MVP o del producto)
- Fuera del producto: despacho, nómina, contabilidad, telemetría nativa, portal de aseguradoras.
- Fase 1.5: API pública completa, mapeo de IDs externos, odómetro por API, alcance de roles por área, usuario multi-empresa, tareas dentro del caso, configuración de workflow por tipo.
- Fase 2: pólizas de flota (N:M), SSO, push/PWA, WhatsApp/SMS, reportes programados, video como evidencia, aprobación de presupuesto, acciones masivas avanzadas, retención configurable.
- Fase 3: telemetría/GPS, integración con aseguradoras, ERP, calendario, combustible (si se decide incluir).

### 26.7 Integraciones necesarias
MVP: proveedor de correo transaccional, almacenamiento de objetos, antivirus, webhooks salientes. Fase 1.5: API pública y conector con el sistema de despacho de referencia que el negocio defina [DECISION REQUIRED]. Posteriores: SSO, WhatsApp/SMS, telemetría, aseguradoras, ERP.

### 26.8 Principales riesgos
| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R1 | Fuga de datos entre tenants por error de filtrado. | Crítico (reputación, legal). | RLS + pruebas automáticas de aislamiento en CI + pentest. |
| R2 | Sobre-configurabilidad que vuelve el producto complejo de operar y de soportar. | Alto. | Defaults sólidos; configuración avanzada oculta; onboarding guiado; límites de personalización. |
| R3 | Workflow de siniestros demasiado rígido para algunos clientes o demasiado laxo para otros. | Alto. | Estados opcionales por tipo; requisitos configurables; override auditado; validar con 3 clientes piloto. |
| R4 | Kilometraje poco confiable ⇒ alertas de mantenimiento inexactas. | Medio. | Alerta por fecha como respaldo; integración de odómetro; visibilidad de "última actualización". |
| R5 | Fatiga de alertas. | Medio. | Digests, umbrales, destinatarios por área, priorización. |
| R6 | Adopción por parte de mecánicos externos y despachadores sin cultura digital. | Medio. | UX móvil mínima; registro por delegación; capacitación. |
| R7 | Variabilidad regulatoria y terminológica por país. | Medio. | Etiquetas y catálogos por empresa; semillas por país; validación legal por mercado. |
| R8 | Crecimiento del almacenamiento de fotos/documentos. | Medio (costo). | Compresión en cliente, límites por plan, retención, almacenamiento frío. |
| R9 | Acoplamiento prematuro al sistema de despacho del primer cliente (o del propio proveedor, si lo tiene) que dificulte vender a terceros. | Alto (estratégico). | Capa de conectores genérica; API pública como único camino de integración, sin excepciones para el primer cliente. |
| R10 | Dependencia de proveedores (correo, WhatsApp) y sus políticas de plantillas. | Bajo. | Abstracción de proveedor; colas con reintento. |

### 26.9 Decisiones pendientes (consolidado)
| ID | Decisión | Impacto | Sección |
|---|---|---|---|
| D1 | Nombre comercial del producto. | Marketing. | §1.1 |
| D2 | Modelo de pricing y límites por plan. | Arquitectura de límites, UX de avisos. | §1.4, §23.5 |
| D3 | Dueño del catálogo de vehículos/conductores cuando hay integración con despacho. | Dirección de sincronización, conflictos. | §1.10, §18.2 |
| D4 | ¿Incluir gestión de combustible? ¿Infracciones de tránsito dentro de incidentes? | Alcance, modelo de datos. | §1.9, §10.1 |
| D5 | Conjunto inicial de KPIs. | Dashboard, reportes. | §2.6 |
| D6 | Alcance de roles por área en MVP o fase 1.5. | RBAC, consultas. | §6.1 |
| D7 | Usuario con membresía en varias empresas. | Modelo de identidad, UX de login. | §6.1 |
| D8 | Despachador puede crear incidentes en `Draft`. | Permisos, UX. | §5.3 |
| D9 | Mecánico externo: ¿usuario con acceso o registro por delegación? | Licenciamiento, seguridad, UX móvil. | §5.5 |
| D10 | Visibilidad de costos para responsable de flotilla. | Permisos por defecto. | §5.2 |
| D11 | Cambios de estado del vehículo automáticos vs. sugeridos (vencimientos, mantenimiento, siniestro). | Reglas, UX, integración. | §8.6, BR-012/013 |
| D12 | Unicidad de conductor principal en varios vehículos. | Regla de negocio. | §8.7 |
| D13 | Pólizas de flota (N:M) en MVP o fase 2. | Modelo de datos. | §8.4 |
| D14 | Aprobación de presupuesto de mantenimiento. | Workflow. | §9.3 |
| D15 | Costo a cargo del conductor como concepto. | Modelo, legal/laboral por país. | §10.2 |
| D16 | Permiso de override de workflow. | Seguridad, auditoría. | §11.2 |
| D17 | Valores de SLA y escalaciones por defecto. | Notificaciones. | §11.3 |
| D18 | Conservar originales de fotos (evidencia legal) vs. solo comprimidas. | Almacenamiento, legal. | §12.1 |
| D19 | Políticas de retención y borrado al fin del contrato. | Legal, almacenamiento. | §12.6, §16.3 |
| D20 | Umbral y rol de aprobación para cierre de siniestros con costo alto. | Workflow. | BR-028 |
| D21 | Acceso del super-admin de plataforma (impersonación). | Seguridad, privacidad. | §6.5, §23.4 |
| D22 | Estrategia de aislamiento: columna + RLS vs. base por tenant para enterprise. | Arquitectura, costo. | §17.1, §23.5 |
| D23 | Cifrado a nivel de aplicación de PII sensible. | Búsqueda, performance. | §23.3 |
| D24 | SLA de disponibilidad, RPO/RTO por plan. | Infraestructura, contrato. | §23.2, §23.7 |
| D25 | Región de residencia de datos. | Infraestructura, legal. | §23.4 |
| D26 | Países objetivo e idiomas. | Catálogos semilla, normativa, i18n. | §4.2, §23.4, §23.6 |
| D27 | Sistema de despacho de referencia para la primera integración. | Prioridad de API/webhooks, conector. | §1.10, §18.2 |

### 26.10 Próximos pasos recomendados
1. **Revisión de este documento** con Dirección y Operaciones; resolver D1–D13 (las que afectan alcance y modelo de datos) en una sesión de trabajo de 2 h.
2. **Validación con 2–3 clientes piloto** (idealmente de perfiles distintos: transporte corporativo, transporte de personal, flota tercerizada) de: workflow de siniestros, campos de vehículo/conductor, catálogos semilla y KPIs.
3. **Confirmar supuestos de contexto**: países objetivo, idiomas, modelo comercial, si el proveedor del producto opera también una flota o un despacho propio (afecta prioridad de integraciones y riesgo R9), y sistema de despacho de referencia para la primera integración.
4. **Arquitectura**: ADRs sobre aislamiento multi-tenant (D22), almacenamiento de archivos, motor de workflow configurable, colas y jobs; prueba de concepto de RLS + pruebas de aislamiento.
5. **UX**: wireframes de S02, S10–S12, S17–S19 y S16 (móvil) para validar con usuarios reales antes de desarrollo.
6. **Desglose en épicas Jira** siguiendo la numeración de módulos (una épica por sección 7–16 + Plataforma + Integraciones), con FR y US como historias y los criterios de §22 como base de QA.
7. **Plan de MVP** por incrementos verticales: (a) tenant + usuarios + áreas + vehículos + conductores + documentos + seguros + alertas; (b) mantenimiento; (c) siniestros y workflow; (d) reportes, dashboard, audit, webhooks.
8. **Legal**: revisión de privacidad y retención por país; acuerdo de tratamiento de datos; términos del SaaS.

---

## Anexo A — Glosario

| Término | Definición en este documento |
|---|---|
| Tenant / Empresa | Cliente de la plataforma con datos aislados. |
| Plantilla operativa | Conjunto de personas de la operación: conductores, despachadores y otros empleados. |
| Número económico | Identificador interno del vehículo asignado por la empresa (etiqueta configurable). |
| Siniestro / Incidente | Evento adverso que involucra a un vehículo; "siniestro" cuando interviene aseguradora. |
| Orden de mantenimiento | Registro de un servicio concreto, preventivo o correctivo. |
| Plan de mantenimiento | Regla recurrente que genera órdenes preventivas. |
| Evidencia | Foto, video o documento que respalda un hecho (siniestro, servicio, inspección). |
| Elegibilidad / Aptitud | Condición de que un vehículo o conductor puede operar según estado, documentos y seguros. |
| SLA | Tiempo objetivo entre estados del workflow de siniestros. |
| RLS | Row-Level Security: filtrado de filas por tenant a nivel de base de datos. |

## Anexo B — Trazabilidad módulo → requerimientos → historias

| Módulo | FR | US | Pantallas |
|---|---|---|---|
| Plataforma y usuarios | FR-001–014, 190–192 | US-001, 081 | S01, S03, S04 |
| RBAC y configuración | FR-020–034 | US-002 | S05, S20, S24 |
| Áreas | FR-040–042 | US-003 | S06 |
| Conductores / despachadores | FR-050–061 | US-016, 020 | S07–S09 |
| Vehículos y seguros | FR-070–093 | US-010–013, 015 | S10–S13 |
| Mecánicos y mantenimiento | FR-095–108 | US-014, 040, 041 | S14–S16 |
| Siniestros y workflow | FR-110–125 | US-021, 030–035, 051 | S17–S20 |
| Documentos y evidencias | FR-130–137 | US-012, 030 | S21 |
| Dashboard y reportes | FR-140–149 | US-050, 052, 060 | S02, S22 |
| Notificaciones | FR-150–155 | US-035 | S23 |
| Búsqueda | FR-160–162 | – | transversal |
| Audit | FR-170–171 | US-070 | S26 |
| Integraciones | FR-180–184 | US-080, 081 | S25, S27 |
