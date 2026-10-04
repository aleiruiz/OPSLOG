# FND-CONTRACTS — contrato runtime v1

SPEC-1.1 / ORCH-1.1 (hereda 1.0) · M0 · taskID FND-CONTRACTS · intento 2 · fencing 2 · baseSHA `d04e487c05fc528e076cb5449063283df0587ed`.

`packages/contracts/src/index.ts` contiene tipos sin ORM y validadores runtime. `TenantContext` es la única fuente confiable del tenant; nunca se acepta `tenantId` desde body, query o header. Errores se serializan con `correlationId`, `fieldErrors` y `missingRequirements`, sin SQL/stack/PII; recursos ausentes usan `notFoundApiError`. Eventos exigen `eventId`, `schemaVersion`, tenant, entidad, UTC, actor con `kind` cerrado y payload mínimo. `OutboxRecord` exige `idempotencyKey`, cuya unicidad es tenant+clave/evento. Archivos exigen categoría, contentType permitido, hash SHA-256, versión, fechas ordenadas y límite por categoría; la URL será firmada y ≤15 min.

Incidentes usan transiciones explícitas; cierre exige checklist/aprobación si aplica y reapertura exige `reopen` + motivo. El contrato no implementa handlers, ORM, AWS ni pantallas. Agregar campos opcionales es compatible; cambios semánticos o de seguridad requieren sucesor.
