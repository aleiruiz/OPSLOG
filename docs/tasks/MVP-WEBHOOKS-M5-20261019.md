# MVP-WEBHOOKS-M5-20261019: webhooks salientes firmados, reintentos, DLQ y panel de entregas

```yaml
id: MVP-WEBHOOKS-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 3 (primer dueño de los archivos compartidos de la ola 3)
base_sha: el main vigente con la ola 2 fusionada (registrarlo)
depends_on:
  - ola 2 de M5 fusionada (registro de jobs del worker de MVP-REPORTS PR 1)
  - ADR-0016 §6 y pregunta 4
requirements:
  [
    FR-181,
    US-015 (webhook emitido),
    US-080 (parte webhook; consulta de elegibilidad por API diferida),
    US-081 (panel de entregas y reintento manual; API keys diferidas),
    BRD §18.4 (subconjunto de SPECS §7),
    BRD S25,
    NFR-S4 (rotación del secreto),
    NFR-S8 (límites),
    SPECS §4.3 (SSRF,
    HMAC,
    replay),
    SPECS §4.4 (webhook en la matriz A/B),
    SPECS §7 (catálogo,
    payload sin PII ni costos,
    cadencia de reintentos,
    DLQ),
  ]
write_paths:
  - packages/domain/webhooks/**
  - packages/persistence/webhooks/**
  - packages/platform/webhooks/** (firma, cliente HTTP con guardia SSRF)
  - apps/api/webhooks/**
  - apps/worker/webhooks/**
  - apps/web/settings/integrations/**
  - packages/contracts/src/bff/webhooks.ts (nuevo)
  - apps/api/bff/src/routes/webhooks.ts y apps/api/bff/src/webhooks.test.ts (nuevos)
  - apps/api/composition/src/platform/webhook-apis.ts y apps/api/composition/src/webhooks-source.ts (nuevos)
  - tests/integration/platform/webhooks.test.ts y tests/integration/platform/mysql-webhooks.test.ts (nuevos)
  - docs/tasks/MVP-WEBHOOKS-M5-20261019.md
shared_paths_owned_in_wave_3:
  - catálogo de permisos (integrations:manage) en identity, access.ts y apps/web/app/permissions.ts
  - registro de contratos (WebhookEventName y WebhookDelivery de packages/contracts/src/index.ts ya existen; se amplían sin romperlos)
  - rutas BFF, composición, worker y arneses MySQL
  - composición de empleados y vehículos (solo publicar eventos driver.* que faltan, sin cambiar reglas)
  - rutas web de Configuración
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción y datos reales
  - API pública, API keys, mapeo de ids externos y odómetro por API (FR-180, FR-182, FR-183: fase 1.5)
  - reglas de negocio de los módulos
status: planned
```

## Encargo

Webhooks salientes básicos (FR-181): el administrador con `integrations:manage` registra endpoints HTTPS públicos, elige eventos del catálogo y ve el historial de entregas con reintento manual (S25). Cada entrega va firmada, con reintentos y DLQ, y nunca puede alcanzar la red interna. Orden y dueños: ADR-0016 §1.

## Catálogo y payload

Eventos de SPECS §7 (ya tipados en `WebhookEventName`): `vehicle.created`, `vehicle.updated`, `vehicle.status_changed`, `driver.created`, `driver.updated`, `driver.eligibility_changed`, `incident.created`, `incident.status_changed`, `incident.closed`, `maintenance.created`, `maintenance.status_changed`. Los `document.*` y `policy.*` de BRD §18.4 quedan fuera (SPECS §7 no los adopta).

- **Fuentes.** Mapeo de eventos internos del outbox a eventos públicos. Hoy no se emiten `driver.created`, `driver.updated` ni `driver.eligibility_changed`: los dos primeros se publican desde la composición de empleados; `driver.eligibility_changed` se deriva comparando la elegibilidad calculada con la última conocida por conductor, recalculada al recibir eventos de empleado, documento, asignación o vehículo y en el escaneo diario.
- **Payload** mínimo, sin PII ni costos: `{id, type, schemaVersion, occurredAt, companyRef, data}` con `data` de ids, número económico o folio y estados. `companyRef` es un identificador opaco por endpoint, no el `tenantId` interno.

## Entrega

- **Firma.** Cabeceras `OPSLOG-Event-Id`, `OPSLOG-Timestamp` y `OPSLOG-Signature: v1=<hex>` con HMAC-SHA256 sobre `<timestamp>.<eventId>.<bytes exactos del cuerpo>`. Se documenta cómo verificar y rechazar replay (tolerancia de 5 minutos y deduplicación por `eventId`).
- **Secreto.** 32 bytes aleatorios mostrados una sola vez; guardado sellado con el cifrador de PII de la empresa (no hash, porque firmar exige el valor). Rotación con dos secretos vigentes durante 24 h y firma doble `v1=a,v1=b`.
- **Guardia SSRF** (SPECS §4.3): solo `https`, puerto 443, sin credenciales en la URL; resolver DNS y rechazar loopback, privadas, link-local, CGNAT, multicast, `169.254.169.254` y equivalentes IPv6 (incluidas IPv4 mapeadas); conectar a la IP validada con SNI del host (sin segunda resolución); sin seguir redirecciones (un 3xx es fallo); tiempo de espera 10 s; cuerpo de respuesta leído hasta 64 KB y descartado. Se valida al registrar y otra vez en cada conexión.
- **Reintentos.** Intento inicial y hasta cinco reintentos a 1m/5m/30m/2h/12h con jitter de ±20 %; 2xx es entregado; 4xx salvo 408 y 429 no se reintenta; después del último, `dead_letter` visible y reintento manual que crea un intento nuevo con el mismo `eventId`. Un endpoint con 20 fallos seguidos se desactiva y se avisa al administrador por MVP-NOTIFY.
- **Límites** (ADR-0016 pregunta 4): 5 endpoints por empresa y 60 entregas por minuto por empresa; el exceso espera, no se pierde.
- **Worker** `apps/worker/webhooks`, registrado en el worker compuesto que corre en el proceso `api`. Idempotente por empresa, endpoint y `eventId`; dos ticks concurrentes no entregan dos veces (reclamo con versión).
- **Prueba de endpoint.** Botón «Enviar prueba» con evento `ping` firmado.

## Web

`/configuracion/integraciones`: lista de endpoints con estado, alta y edición (URL, eventos, activo), secreto mostrado una vez con copiar, rotar secreto, historial de entregas por endpoint con código de respuesta, duración, intento y estado (`pending`, `delivered`, `failed`, `dead_letter`), reintento manual. Sin cuerpo de respuesta del receptor en pantalla. Estados de SPECS §8.

## Pruebas de aceptación

1. **Firma.** Given un receptor de prueba, Then la firma verifica sobre los bytes exactos; un cuerpo alterado en un byte no verifica; un timestamp de hace 6 minutos se rechaza en el ejemplo de verificación.
2. **SSRF.** Given URLs con `http`, `localhost`, `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]`, `[::ffff:10.0.0.1]`, un nombre que resuelve a privada y otro que cambia de pública a privada entre registro y envío (rebinding), Then todas se rechazan y ninguna conexión sale.
3. **Redirección.** Given un receptor que responde 302 a una IP privada, Then no se sigue y el intento es fallo.
4. **Cadencia.** Given un receptor que siempre falla y reloj determinista, Then los intentos ocurren a 1m/5m/30m/2h/12h dentro del jitter y terminan en `dead_letter`; el reintento manual entrega con el mismo `eventId`.
5. **Idempotencia.** Given dos workers sobre la misma entrega, Then un solo envío; given el mismo evento del outbox dos veces, Then una sola entrega por endpoint.
6. **Tenant A/B.** Given endpoints en A y B, Then un evento de A nunca llega al endpoint de B, el historial de B da 404 desde A y el secreto de A no firma entregas de B.
7. **Payload.** Given cada evento del catálogo, Then el cuerpo no contiene PII, importes ni el `tenantId` interno.
8. **Permiso.** Given un miembro con `manage_config` y sin `integrations:manage`, Then la gestión de webhooks da 403.
9. **Secreto.** Given un endpoint creado, Then el secreto no aparece en lecturas, logs, audit ni outbox; en MySQL se guarda sellado.
10. **Eventos de conductor.** Given un conductor cuya licencia vence, Then se emite un solo `driver.eligibility_changed` y otro al renovarla.

## Decisiones por defecto

- Permiso nuevo `integrations:manage`; `admin` lo recibe en las plantillas sintéticas.
- Sin mTLS ni IPs de salida fijas en la demo (Coolify); documentado para la cuenta del cliente.
- Las entregas se guardan 30 días.

## Tamaño

Un PR de unas 2.600 líneas con pruebas. Si crece, PR 1 (dominio, firma, guardia SSRF, worker) y PR 2 (eventos de conductor, web). Ningún archivo de producción supera 400 líneas.

## Fuera de alcance

API pública y API keys (FR-180, fase 1.5), webhooks entrantes, eventos `document.*` y `policy.*`, IP de salida fija.

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/MVP-WEBHOOKS-M5-20261019.md
git diff --check
```

Registrar SHA, MySQL exacto y la matriz requisito → contrato → implementación → prueba → evidencia. PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.
