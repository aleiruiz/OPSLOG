# OPSLOG — SPEC-1.2: auditoría única y coordinación autónoma

Fecha: 2026-10-04. Sucesora acotada adoptada por instrucciones directas del usuario; hereda SPEC-1.0 y SPEC-1.1 salvo estas sustituciones.

Cada PR requiere exactamente una auditoría independiente por headSHA, por una sesión del proveedor activo que no haya participado como autora. Se eliminan subauditorías locales y segundos auditores de PR; no lanzarlos sin autorización expresa. No se exige review formal de GitHub ni revisión cruzada entre proveedores. Publicar PRs listos para revisión, nunca draft. Un cambio de código invalida la revisión y requiere revalidación sobre el SHA nuevo.

El orquestador fusiona automáticamente cuando el candidato actualizado cumple CI requerido, auditoría y resolución de hallazgos. No solicita aprobación humana rutinaria. Conserva todas las pruebas, trazabilidad, aislamiento, design system primero y barreras acumulativas G0–G5. La cantidad de auditores de hito prevista en 1.1 se conserva: sus informes acumulativos son un proceso diferente de la única auditoría de cada PR, no una excusa para duplicarla.

Implementación, reparación de entorno, integración y auditoría se ejecutan en sesiones separadas del coordinador, siempre con gpt-5.6-luna durante Codex o claude-sonnet-5 durante Claude. Un proveedor activo por repositorio. El coordinador toma tareas elegibles sin pedir instrucciones adicionales; un pulse periódico reanuda su coordinación sin mantener un turno esperando CI. Las sesiones separan contexto, pero no se asume que separen límites de uso de la cuenta.

AWS continúa diferido por ADR-0002. Producción requiere autorización separada. Intervención humana limitada a decisiones materiales fuera de lo autorizado y validación concreta del producto en gates cuando sea necesaria. Esta sucesora no declara ningún gate aprobado.
