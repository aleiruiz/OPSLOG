# CORE-FILES-M1-20261006 — archivos privados, cuarentena/escaneo y descarga autorizada

```yaml
id: CORE-FILES-M1-20261006
baseline:
  [
    SPEC-1.4,
    ORCH-1.4,
    inherited: SPEC-1.0/ORCH-1.0,
    SPEC-1.1/ORCH-1.1,
    SPEC-1.2/ORCH-1.2,
    SPEC-1.3/ORCH-1.3,
  ]
milestone: M1
kind: implementation
baseSHA: b0f45f5eb6f3f6c013064fa9d2344b378a7ece06
depends_on: [G0-human-reaffirmed]
write_paths:
  [
    packages/platform/files/**,
    packages/domain/files/**,
    apps/api/files/**,
    infra/storage/**,
    docs/tasks/CORE-FILES-M1-20261006.md,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    docs/baselines/**,
    Tasks.md,
    .orchestrator/**,
    .env*,
    package.json,
    tsconfig.json,
    pnpm-lock.yaml,
    packages/contracts/**,
    packages/persistence/**,
    packages/platform/audit/**,
    packages/platform/auth/**,
    packages/platform/outbox/**,
    packages/domain/identity/**,
    apps/api/auth/**,
    apps/api/tenants/**,
    apps/web/**,
    apps/worker/**,
  ]
```

Slice CORE-FILES de M1 (Orchestrator, sección CORE-FILES; SPECS §5–§7; FR-130, FR-131, FR-134). Sin dependencias de terceros nuevas: puertos más dobles en memoria; el adaptador S3 real queda solo como interfaz (AWS diferido, ADR-0002) y la integración IAM real es aparte del emulator. Solo datos sintéticos.

## Alcance implementado

- `packages/domain/files`: reglas puras. Tipo por contenido (magic bytes JPEG/PNG/WebP/PDF; DOCX/XLSX por firma ZIP más partes `[Content_Types].xml` y `word/`/`xl/`), tipo declarado en allowlist (sin ZIP/video/HEIC), tope 15 MB imágenes y 25 MB documentos, nombres y `Content-Disposition` saneados (siempre `attachment`), ciclo `pending_scan → clean | rejected` (`clean` equivale a "released"; estados terminales inmutables), originales vs derivados (derivado ≤2000 px por lado, ligado a un original del mismo tenant), regla `assertDownloadable` y `FileRecordStore` con compare-and-set por estado (adaptador en memoria con clave tenant+id).
- `packages/platform/files`: puerto `ObjectStorage` privado (sin URL, presign ni listado; `putIfAbsent` impide sobrescribir originales; claves `tenants/<tenant>/{quarantine|released}/{originals|derivatives}/<id>` con segmentos opacos validados), `VirusScanner` y `ScanQueue` (reclamo atómico con lease, backoff exponencial), `FilePipeline` (ingesta a cuarentena, escaneo, copia a released antes de marcar `clean`, derivados), `DownloadGrants` (HMAC, TTL por defecto 5 min, máximo 15 min por FR-134, ligado a tenant, archivo y actor) y `auditFileEvent` sobre `AuditStore`/`createAuditEvent` existentes (sin modificarlos).
- `apps/api/files`: `FilesApi` sobre `IdentityService`/`IdentityAccessResolver` existentes. Cada llamada reautentica y reresuelve permisos (sin caché), de modo que revocar la sesión, la membresía o el permiso bloquea el proxy aunque el grant siga vigente. El tenant sale de la sesión, nunca de la entrada. Descarga solo con grant del mismo tenant y actor, estado `clean`, permiso `view` (+`view_pii` para archivos PII) y verificación del hash antes de servir; la auditoría de descarga se escribe antes de devolver bytes y, si falla, no se devuelven.
- `infra/storage`: descripción declarativa del bucket privado (bloqueo de acceso público, ACLs deshabilitadas, versionado, SSE-KMS, TLS obligatorio, sin CORS, expiración de cuarentena), validadores `validateBucketConfig`/`validateAppPolicy` (mínimo privilegio, prefijo de tenant, sin comodines) e interfaz `S3ObjectClient` sin implementación.

## Trazabilidad requisito → prueba

| Requisito / aceptación                     | Implementación                                     | Pruebas                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FR-130/131 tipo por contenido y tamaño     | `validateUpload`, `detectFamily`                   | `packages/domain/files/src/index.test.ts` (validación, límites 15/25 MB, spoofing)                                                        |
| Cuarentena → escaneo → released            | `FilePipeline`                                     | `packages/platform/files/src/pipeline.test.ts`                                                                                            |
| Archivos falsos/pendientes no se descargan | `assertDownloadable`, hash en proxy                | `apps/api/files/src/index.test.ts` (pendiente, rechazado, bytes alterados, objeto ausente, spoof en subida)                               |
| Otro tenant no descarga                    | clave tenant+id, tenant desde sesión, grant ligado | `apps/api/files/src/index.test.ts` (A/B, mismo id local en ambos tenants, grant ajeno)                                                    |
| Acceso directo privado                     | puerto sin URL; reglas de bucket                   | `packages/platform/files/src/storage.test.ts`, `infra/storage/src/index.test.ts` (solo configuración declarada; no valida un bucket real) |
| Revocación bloquea proxy                   | reautenticación por llamada                        | `apps/api/files/src/index.test.ts` (sesión, membresía, permiso)                                                                           |
| Scanner caído solo encola                  | `processJob` difiere con backoff                   | `packages/platform/files/src/pipeline.test.ts`, `apps/api/files/src/index.test.ts`                                                        |
| Originales vs derivados                    | `ingestDerivative`, `putIfAbsent`                  | `pipeline.test.ts` (original intacto, ≤2000 px, padre limpio)                                                                             |
| Audit sin PII (FR-134)                     | `auditFileEvent` solo ids y etiquetas              | `apps/api/files/src/index.test.ts` (sin nombre, contenido ni hash)                                                                        |
| URL/grant ≤15 min                          | `DownloadGrants`                                   | `storage.test.ts`                                                                                                                         |

## Limitaciones y pendientes (no se declaran cumplidos)

- Todos los adaptadores son en memoria; no hay persistencia durable ni prueba MySQL/S3 real. Integración AWS IAM real, KMS y emulator quedan para CORE-INTEGRATE/aparte.
- Un fallo entre insertar el registro y encolar el escaneo deja un archivo `pending_scan` sin trabajo en cola (nunca descargable); falta un reconciliador durable. El destino de la cola es un adaptador durable futuro (no se reutiliza `infra/queues` para no acoplar paquetes).
- La detección DOCX/XLSX es heurística (firma ZIP y nombres de partes); no valida el OOXML completo ni detecta macros. HEIC, video (FR-137), conversión de derivados, renovación por versiones (FR-133), soft delete/retención (FR-136) y captura móvil (FR-135) quedan fuera de este slice.
- El escáner es una interfaz con un fake sintético; no hay antivirus real.
- Cableado raíz pendiente (rutas prohibidas para este paquete): `tsconfig.json` (referencias), `format:check` y `test:unit` raíz no incluyen aún estos paquetes. Cada paquete trae su propio script `test:unit` con umbrales 90/90/90/85 (`pnpm --filter <paquete> test:unit`); el integrador debe añadirlos al `package.json` raíz con una lease adicional.
- Auditoría de eventos: el actor se emite como `user-<uuid>` (formato aceptado por `packages/platform/audit`); el payload solo puede llevar `attempts`.

## Verificación en el worktree

Node/pnpm del entorno; `tsc -b` de los cuatro proyectos (strict, `exactOptionalPropertyTypes`), ESLint con `--max-warnings 0` y Prettier sobre los paths del paquete, `pnpm --filter … test:unit` de los cuatro paquetes con umbrales 90/85 y `pnpm baseline:check`. Los resultados se reportan en el PR; ningún gate se declara pasado desde este documento.
