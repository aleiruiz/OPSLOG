# ADR-0012 — Arranque austero en AWS y crecimiento por etapas

Estado: **aceptado por el propietario el 2026-10-06** ("Yes go ahead", en el hilo del proyecto, tras presentarle la propuesta austera con la API en Lambda como opción por defecto). Aceptar este ADR no autoriza aprovisionar nada en AWS: AWS sigue diferido y los importes son estimaciones sin verificar.
Fecha: 2026-10-06.
Compatible con SPEC-1.4 y ORCH-1.4; no modifica sus baselines.

## Contexto

El propietario indicó: «quiero un presupuesto inicial realmente pequeño; el proyecto debe arrancar casi gratis y crecer desde ahí». SPECS §3 selecciona una arquitectura AWS pensada para un entorno completo: ECS Fargate (API y worker), ALB, red privada para la base de datos, Secrets Manager, CloudWatch y entorno de pruebas separado del de producción. Esa arquitectura es válida, pero su costo fijo (balanceador, NAT, Multi-AZ, segunda copia de pruebas) es desproporcionado mientras haya pocos usuarios.

Estimaciones de orden de magnitud del plan completo, **de memoria y sin verificar** (se re-comprueban en el inventario, ver abajo): pruebas aproximadamente 150–250 USD/mes; producción pequeña con alta disponibilidad aproximadamente 350–600 USD/mes.

AWS sigue diferido y sin aprovisionar (ADR-0002, `infra/plan/AWS.md`): no existe conexión, recurso ni gasto atribuible a este proyecto. Este ADR solo fija el nivel inicial de la arquitectura para cuando se reactive AWS.

## Decisión

Adoptar un **nivel de arranque austero** (etapa 0) con mejora independiente de cada pieza cuando aparezca uso real.

Etapa 0 (objetivo: aproximadamente 15–30 USD/mes con el RDS reutilizado, estimación sin verificar):

1. **Base de datos:** reutilizar el RDS MySQL de pruebas existente, tras el inventario de `infra/plan/AWS.md` §5, con base de datos y usuario separados y de mínimo privilegio (sin usuario master en runtime). Si hubiera que crear una instancia, será Single-AZ `db.t4g.micro` (estimación aproximada 15–20 USD/mes) sin réplicas.
2. **API (forma A, por defecto):** una sola tarea Fargate pequeña (alternativa equivalente: una instancia `t4g.nano`) en una subred pública con IP pública, security group restringido y sin balanceador. Se ejecuta en el mismo VPC que el RDS, que permanece privado. Alcanza SQS (si se usa), SSM, Cognito y SES por internet sin NAT. Ver «Forma de cómputo de la etapa 0».
3. **Red:** sin NAT gateway ni endpoints de interfaz en la etapa 0. La base de datos no es accesible desde internet: su security group solo admite el del cómputo de OPSLOG y se exige TLS validado. El cómputo solo admite entrada HTTPS desde donde corresponda (CloudFront/clientes) y salida a servicios AWS.
4. **SPA:** S3 privado + CloudFront.
5. **Identidad:** Cognito (nivel gratuito, sujeto a límites vigentes).
6. **Correo y colas:** SES. SQS se difiere en la etapa 0 si las primeras funcionalidades no requieren colas (ver más abajo); no entran endpoints de interfaz.
7. **Secretos y configuración:** SSM Parameter Store (SecureString con KMS) en lugar de Secrets Manager.
8. **Observabilidad y copias:** CloudWatch Logs con retención de 7–14 días; sin Multi-AZ y sin segunda copia de pruebas (una sola instancia de pruebas; producción se crea después, con autorización separada).

### Forma de cómputo de la etapa 0

Una Lambda dentro del VPC (necesaria para alcanzar un RDS privado) no tiene salida a internet desde una subred pública: SQS y SSM quedarían inalcanzables salvo con un NAT gateway (aprox. 35 USD/mes, sin verificar) o endpoints de interfaz (aprox. 7 USD/mes cada uno por zona de disponibilidad, sin verificar). Ambos rompen el objetivo de la etapa 0. Por eso se definen dos formas coherentes:

- **Forma A (por defecto): tarea Fargate pequeña o `t4g.nano` en subred pública con IP pública.** RDS privado en el mismo VPC; security group del cómputo con entrada limitada y salida a servicios AWS por internet; sin NAT. Costo estimado (sin verificar): Fargate 0,25 vCPU/0,5 GB ARM 24x7 aprox. 9–10 USD/mes, o `t4g.nano` aprox. 3–4 USD/mes más disco; IPv4 pública aprox. 3,6 USD/mes; logs y CloudFront aprox. 1–3. Una IP de tarea Fargate cambia al reemplazarse: un endpoint estable requiere (i) CloudFront o un nombre DNS delante (registro DNS mantenido por Cloud Map o similar, aprox. 0,5–1 USD/mes con zona alojada; el origen debe servir TLS válido), o (ii) en `t4g.nano`, una Elastic IP (aprox. 3,6 USD/mes por IPv4 pública). Sin balanceador. La disponibilidad es de una sola tarea: aceptable solo en pruebas/datos sintéticos.
- **Forma B (alternativa, requiere aceptación expresa del propietario): Lambda fuera del VPC con RDS «publicly accessible».** Es la más barata y no necesita NAT ni endpoints, pero la base queda alcanzable desde internet y protegida solo por credenciales y TLS (más un security group con rangos que no podrán ser fijos para Lambda). Es un compromiso de seguridad real que contradice «datos en red privada»; se acepta, si acaso, solo para datos sintéticos de pruebas y **probablemente no es aceptable para datos reales**. No se adopta sin decisión escrita del propietario.

Se elige la forma A porque conserva el RDS privado, sin debilitar los controles de seguridad que este ADR declara intactos, a un costo similar. Lambda con VPC (forma C) solo vuelve a ser viable al llegar a NAT/endpoints (etapa 2).

SQS: SPECS §3 prevé outbox transaccional con SQS para entregas y trabajos largos. La fuente de verdad es el outbox en la base del tenant (publicación externa tras el commit, con reintentos e idempotencia, según SPECS). En la etapa 0, si no hay funcionalidades con entrega externa ni trabajos largos, el worker puede vaciar el outbox directamente desde la base, sin SQS; añadir SQS después es un cambio de adaptador sin cambiar el contrato. Si una funcionalidad de la etapa 0 exige colas, SQS entra (costo marginal) y se alcanza por internet desde la forma A.

### Qué cambia y qué no

Este ADR ajusta SPECS §3 (filas «AWS runtime» y, en la práctica, «Asíncrono» solo en cuanto a cómputo) **únicamente para el nivel inicial de despliegue**. No cambia:

- el alcance de producto ni la API REST `/api/v1`;
- los controles de seguridad: TLS, datos en red no pública, cifrado KMS, IAM de mínimo privilegio, sin usuario root/master de base de datos en runtime, aislamiento por tenant, objetos S3 privados;
- los criterios de gate (G0–G5), CI, leak scan ni auditorías;
- la regla de que AWS sigue diferido y sin aprovisionar (ADR-0002) y producción sin autorización.

El dominio es independiente de AWS (SPECS §3), de modo que pasar de una tarea única a varias, o agregar balanceador o NAT, es un cambio de infraestructura/composición y no de producto.

### Etapas y disparadores de mejora

Todos los costos son **estimaciones sin verificar, de memoria**, en USD/mes, para re-comprobar con la calculadora de precios al hacer el inventario. Supuestos: poca carga, un solo entorno, retención de logs corta, sin tráfico saliente significativo.

| Etapa                         | Componentes                                                                                                                                                                                                                                             | Costo estimado (supuestos)                                                                  | Disparador para pasar a la siguiente                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Arranque austero           | RDS de pruebas reutilizado (o `db.t4g.micro` Single-AZ nueva); forma A: una tarea Fargate pequeña (o `t4g.nano`) en subred pública, sin NAT; S3 + CloudFront; Cognito gratuito; SES; SQS diferido si no hace falta; SSM Parameter Store; logs 7–14 días | ~15–30 (supone RDS reutilizado; ~15–20 más si se crea instancia)                            | Usuarios reales activos fuera del equipo; o cualquier dato real de clientes.                                                                                                                                                     |
| 1. Piloto con datos reales    | Etapa 0 + instancia de producción separada Single-AZ con backups/PITR; alarmas y Budgets; logs 30 días; Secrets Manager solo para credenciales que necesiten rotación                                                                                   | ~40–100                                                                                     | Disponibilidad exigida por contrato o negocio (RTO/RPO); más de unas decenas de usuarios concurrentes; carga sostenida de la API (aprox. varios RPS constantes) que sature la tarea única.                                       |
| 2. Producción con resiliencia | RDS Multi-AZ y tamaño mayor; API en Fargate con ALB, o Lambda en VPC si ya hay NAT/endpoints; ALB; WAF si hay exposición pública; logs 90 días                                                                                                          | ~200–350                                                                                    | Necesidad de red privada completa y salida controlada (NAT ~35 USD/mes o endpoints de interfaz ~7 USD/mes cada uno por zona, sin verificar); volumen de datos o conexiones que superen la instancia; requisitos de cumplimiento. |
| 3. Plan completo de SPECS §3  | Producción pequeña HA: Fargate API/worker, ALB, NAT/endpoints, Multi-AZ, Secrets Manager, CloudWatch/OpenTelemetry; pruebas como entorno propio                                                                                                         | pruebas ~150–250; producción ~350–600 (cifras del plan completo, de memoria, sin verificar) | Crecimiento sostenido; auditoría final y autorización de producción por el propietario.                                                                                                                                          |

Cada pieza mejora de forma independiente: p. ej. Multi-AZ puede llegar antes que el ALB si el requisito es disponibilidad de datos. Los disparadores son criterios para revisar la decisión, no automatismos: cada salto requiere aprobación del propietario.

### Control de costos (guardarraíles)

- **AWS Budgets:** alertas por correo al propietario a umbrales fijos de la etapa vigente: 50 %, 80 % y 100 % del gasto real y 100 % del pronosticado. El presupuesto mensual inicial lo fija el propietario (propuesta: 30 USD para etapa 0); no se escribe una cifra aprobada en el repositorio hasta que él la confirme.
- **Etiquetas obligatorias** en todo recurso: al menos `proyecto=opslog`, `entorno`, `etapa` y `propietario`; activadas como etiquetas de asignación de costos.
- **Ningún recurso sin aprobación del propietario:** cada recurso nuevo se enumera en el inventario/IaC con propietario, etapa y costo estimado, y se revisa el cambio de costo antes de aplicar (`infra/plan/AWS.md` §6). Nada de recursos manuales fuera de IaC.
- Sin servicios de costo fijo no listados en la etapa vigente (NAT gateway, endpoints de interfaz, ALB, Multi-AZ) hasta cumplirse su disparador.
- Revisión mensual del gasto real contra la estimación; si difiere, actualizar este ADR por sucesión.
- Sin credenciales, identificadores de cuenta, regiones ni endpoints en este documento; esos datos se resuelven en el inventario (ADR-0001).

## Alternativas consideradas

- **Plan completo desde el inicio (SPECS §3 tal cual):** máxima fidelidad a la arquitectura destino, pero costo fijo alto sin usuarios que lo justifiquen. Rechazada para el arranque; sigue siendo la etapa 3.
- **Lambda + HTTP API (propuesta inicial de este ADR):** barata, pero para alcanzar un RDS privado exige VPC y entonces NAT o endpoints de interfaz; sin ellos, solo la forma B (RDS público). Descartada para la etapa 0 y reconsiderable en la etapa 2.
- **Plataformas ajenas a AWS o instancia única EC2:** más barato en bruto, pero abandona los servicios ya seleccionados (Cognito, SES, SQS) y exigiría sustituir selecciones de SPECS con prueba de equivalencia. Rechazada.
- **Mantener Secrets Manager desde el inicio:** mejor rotación, con costo por secreto. SSM Parameter Store cubre el arranque; se migra al requerir rotación automática.

## Consecuencias

- Costo fijo inicial bajo, a cambio de menos disponibilidad (Single-AZ, sin balanceador) y de restricciones de red: aceptable solo en pruebas o con datos sintéticos. **Producir con datos reales exige al menos la etapa 1 y la autorización de producción por separado.**
- Compartir el RDS existente implica riesgo para otras aplicaciones: el inventario debe confirmar capacidad y permisos, y OPSLOG no modifica datos ni permisos ajenos (AGENTS.md regla 10).
- El cómputo en subred pública con IP pública reduce defensa en profundidad frente a la red privada de SPECS (el RDS sí permanece privado); se compensa con security groups estrictos, TLS validado y mínimo privilegio, y se revierte al llegar al disparador. La forma B queda excluida salvo aceptación expresa del propietario.
- La IaC (CDK) debe parametrizar la etapa para que cada mejora sea un cambio de configuración y no una reescritura.
- Todas las cifras son estimaciones sin verificar; deben re-comprobarse en el inventario con precios vigentes antes de cualquier aprobación.
- Este ADR no declara ningún gate pasado ni autoriza conexión, aprovisionamiento ni gasto en AWS.
