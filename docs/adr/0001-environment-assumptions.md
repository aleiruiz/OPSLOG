# ADR-0001 — Supuestos de entorno AWS para planificación

Estado: aceptado para planificación por instrucción directa del usuario.
Fecha: 2026-10-03, America/Mexico_City.
Compatible con SPEC-1.0 y ORCH-1.0; no modifica sus baselines.

## Contexto

El usuario confirmó Amazon RDS y proporcionó un resultado de consulta desde MySQL Workbench: versión `8.0.45`, comentario `Source distribution`. También confirmó disponibilidad de instancias de producción y de pruebas e indicó que la región exacta no es relevante en esta etapa.

## Decisión

- Asumir Sudamérica para diseñar la infraestructura. No asignar un identificador de región AWS ni afirmar la ubicación real de las instancias sin inventario.
- Considerar entornos de producción y pruebas separados. Su existencia no prueba todavía aislamiento de cuentas, red, credenciales, objetos o datos; FND-AWS documentará esos límites cuando se prepare la conexión.
- Usar MySQL 8.0.45 como versión de destino a cubrir en integración; validar disponibilidad de la imagen/runtime de pruebas durante FND-REPO.
- Diferir identificación de región, endpoints y selección concreta de la instancia de pruebas hasta la preparación de conexión/despliegue. No bloquear planificación, contratos, design system ni desarrollo local por falta de región exacta.
- Mantener pruebas CI y auditorías cerradas con MySQL efímero y datos sintéticos. No usar producción para fixtures; no asumir que la instancia de pruebas tiene datos desechables.

## Consecuencias

La configuración de infraestructura tendrá parámetros por entorno, sin regiones ni endpoints inventados. Costos, disponibilidad de servicios, red, permisos y backups se verificarán antes de actuar sobre AWS. Esta decisión no autoriza cambios a producción ni altera los gates de calidad, auditoría y despliegue definidos en las baselines.
