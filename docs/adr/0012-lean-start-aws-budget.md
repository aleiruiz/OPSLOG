# ADR-0012 — Arranque austero en AWS y crecimiento por etapas

Estado: **propuesto; decisión del propietario por transcribir.** El propietario pidió un presupuesto inicial muy pequeño; la propuesta de abajo se le presentó y no la ha objetado, pero este repositorio no puede verificarlo (misma limitación que ADR-0008, ADR-0009 y ADR-0011). Hasta que el propietario la confirme, este ADR es una propuesta y no autoriza nada en AWS.
Fecha: 2026-10-06.
Compatible con SPEC-1.4 y ORCH-1.4; no modifica sus baselines.

## Contexto

El propietario indicó: «quiero un presupuesto inicial realmente pequeño; el proyecto debe arrancar casi gratis y crecer desde ahí». SPECS §3 selecciona una arquitectura AWS pensada para un entorno completo: ECS Fargate (API y worker), ALB, red privada para la base de datos, Secrets Manager, CloudWatch y entorno de pruebas separado del de producción. Esa arquitectura es válida, pero su costo fijo (balanceador, NAT, Multi-AZ, segunda copia de pruebas) es desproporcionado mientras haya pocos usuarios.

Estimaciones de orden de magnitud del plan completo, **de memoria y sin verificar** (se re-comprueban en el inventario, ver abajo): pruebas aproximadamente 150–250 USD/mes; producción pequeña con alta disponibilidad aproximadamente 350–600 USD/mes.

AWS sigue diferido y sin aprovisionar (ADR-0002, `infra/plan/AWS.md`): no existe conexión, recurso ni gasto atribuible a este proyecto. Este ADR solo fija el nivel inicial de la arquitectura para cuando se reactive AWS.

## Decisión

Adoptar un **nivel de arranque austero** (etapa 0) con mejora independiente de cada pieza cuando aparezca uso real.

Etapa 0 (objetivo: aproximadamente 0–25 USD/mes, estimación sin verificar):

1. **Base de datos:** reutilizar el RDS MySQL de pruebas existente, tras el inventario de `infra/plan/AWS.md` §5, con base de datos y usuario separados y de mínimo privilegio (sin usuario master en runtime). Si hubiera que crear una instancia, será Single-AZ `db.t4g.micro` (estimación aproximada 15–20 USD/mes) sin réplicas.
2. **API:** AWS Lambda detrás de un HTTP API (opción por defecto). Alternativa: una sola tarea Fargate pequeña. Sin balanceador de carga.
3. **Red:** sin NAT gateway. Subredes públicas con security groups restringidos, o VPC endpoints donde el servicio lo permita. La base de datos no se expone a internet: el acceso queda limitado por security group al cómputo de OPSLOG y se exige TLS validado.
4. **SPA:** S3 privado + CloudFront.
5. **Identidad:** Cognito (nivel gratuito, sujeto a límites vigentes).
6. **Correo y colas:** SES y SQS (uso bajo, costo marginal).
7. **Secretos y configuración:** SSM Parameter Store (SecureString con KMS) en lugar de Secrets Manager.
8. **Observabilidad y copias:** CloudWatch Logs con retención de 7–14 días; sin Multi-AZ y sin segunda copia de pruebas (una sola instancia de pruebas; producción se crea después, con autorización separada).

### Qué cambia y qué no

Este ADR ajusta SPECS §3 (filas «AWS runtime» y, en la práctica, «Asíncrono» solo en cuanto a cómputo) **únicamente para el nivel inicial de despliegue**. No cambia:

- el alcance de producto ni la API REST `/api/v1`;
- los controles de seguridad: TLS, datos en red no pública, cifrado KMS, IAM de mínimo privilegio, sin usuario root/master de base de datos en runtime, aislamiento por tenant, objetos S3 privados;
- los criterios de gate (G0–G5), CI, leak scan ni auditorías;
- la regla de que AWS sigue diferido y sin aprovisionar (ADR-0002) y producción sin autorización.

El dominio es independiente de AWS (SPECS §3), de modo que pasar de Lambda a Fargate, o agregar balanceador o NAT, es un cambio de infraestructura/composición y no de producto.

### Etapas y disparadores de mejora

Todos los costos son **estimaciones sin verificar, de memoria**, en USD/mes, para re-comprobar con la calculadora de precios al hacer el inventario. Supuestos: poca carga, un solo entorno, retención de logs corta, sin tráfico saliente significativo.

| Etapa                         | Componentes                                                                                                                                                           | Costo estimado (supuestos)                                                                  | Disparador para pasar a la siguiente                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Arranque austero           | RDS de pruebas reutilizado (o `db.t4g.micro` Single-AZ nueva); Lambda + HTTP API; S3 + CloudFront; Cognito gratuito; SES; SQS; SSM Parameter Store; logs 7–14 días    | ~0–25 (supone RDS reutilizado; ~15–20 más si se crea instancia)                             | Usuarios reales activos fuera del equipo; o cualquier dato real de clientes.                                                                                                                                         |
| 1. Piloto con datos reales    | Etapa 0 + instancia de producción separada Single-AZ con backups/PITR; alarmas y Budgets; logs 30 días; Secrets Manager solo para credenciales que necesiten rotación | ~40–100                                                                                     | Disponibilidad exigida por contrato o negocio (RTO/RPO); más de unas decenas de usuarios concurrentes; carga sostenida de la API (aprox. varios RPS constantes) que haga caro o lento el arranque en frío de Lambda. |
| 2. Producción con resiliencia | RDS Multi-AZ y tamaño mayor; API en Fargate (o Lambda con concurrencia reservada); ALB; WAF si hay exposición pública; logs 90 días                                   | ~200–350                                                                                    | Necesidad de red privada completa y salida controlada (NAT o endpoints); volumen de datos o conexiones que superen la instancia; requisitos de cumplimiento.                                                         |
| 3. Plan completo de SPECS §3  | Producción pequeña HA: Fargate API/worker, ALB, NAT/endpoints, Multi-AZ, Secrets Manager, CloudWatch/OpenTelemetry; pruebas como entorno propio                       | pruebas ~150–250; producción ~350–600 (cifras del plan completo, de memoria, sin verificar) | Crecimiento sostenido; auditoría final y autorización de producción por el propietario.                                                                                                                              |

Cada pieza mejora de forma independiente: p. ej. Multi-AZ puede llegar antes que el ALB si el requisito es disponibilidad de datos. Los disparadores son criterios para revisar la decisión, no automatismos: cada salto requiere aprobación del propietario.

### Control de costos (guardarraíles)

- **AWS Budgets:** alertas por correo al propietario a umbrales fijos de la etapa vigente: 50 %, 80 % y 100 % del gasto real y 100 % del pronosticado. El presupuesto mensual inicial lo fija el propietario (propuesta: 25 USD para etapa 0); no se escribe una cifra aprobada en el repositorio hasta que él la confirme.
- **Etiquetas obligatorias** en todo recurso: al menos `proyecto=opslog`, `entorno`, `etapa` y `propietario`; activadas como etiquetas de asignación de costos.
- **Ningún recurso sin aprobación del propietario:** cada recurso nuevo se enumera en el inventario/IaC con propietario, etapa y costo estimado, y se revisa el cambio de costo antes de aplicar (`infra/plan/AWS.md` §6). Nada de recursos manuales fuera de IaC.
- Sin servicios de costo fijo no listados en la etapa vigente (NAT, ALB, Multi-AZ, endpoints de interfaz) hasta cumplirse su disparador.
- Revisión mensual del gasto real contra la estimación; si difiere, actualizar este ADR por sucesión.
- Sin credenciales, identificadores de cuenta, regiones ni endpoints en este documento; esos datos se resuelven en el inventario (ADR-0001).

## Alternativas consideradas

- **Plan completo desde el inicio (SPECS §3 tal cual):** máxima fidelidad a la arquitectura destino, pero costo fijo alto sin usuarios que lo justifiquen. Rechazada para el arranque; sigue siendo la etapa 3.
- **API en una tarea Fargate pequeña, sin balanceador:** conserva el modelo de proceso de SPECS, a costo fijo algo mayor que Lambda y con IP/TLS a resolver. Aceptable como alternativa si Lambda resulta inadecuado (p. ej. conexiones a MySQL o arranque en frío).
- **Plataformas ajenas a AWS o instancia única EC2:** más barato en bruto, pero abandona los servicios ya seleccionados (Cognito, SES, SQS) y exigiría sustituir selecciones de SPECS con prueba de equivalencia. Rechazada.
- **Mantener Secrets Manager desde el inicio:** mejor rotación, con costo por secreto. SSM Parameter Store cubre el arranque; se migra al requerir rotación automática.

## Consecuencias

- Costo fijo inicial bajo, a cambio de menos disponibilidad (Single-AZ, sin balanceador) y de restricciones de red: aceptable solo en pruebas o con datos sintéticos. **Producir con datos reales exige al menos la etapa 1 y la autorización de producción por separado.**
- Compartir el RDS existente implica riesgo para otras aplicaciones: el inventario debe confirmar capacidad y permisos, y OPSLOG no modifica datos ni permisos ajenos (AGENTS.md regla 10).
- Subredes públicas con security groups estrictos reducen defensa en profundidad frente a la red privada de SPECS; se compensa con acceso limitado por security group, TLS validado y mínimo privilegio, y se revierte al llegar al disparador.
- La IaC (CDK) debe parametrizar la etapa para que cada mejora sea un cambio de configuración y no una reescritura.
- Todas las cifras son estimaciones sin verificar; deben re-comprobarse en el inventario con precios vigentes antes de cualquier aprobación.
- Este ADR no declara ningún gate pasado ni autoriza conexión, aprovisionamiento ni gasto en AWS.
