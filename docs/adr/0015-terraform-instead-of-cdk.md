# ADR-0015 — Terraform en lugar de CDK TypeScript para la IaC

Estado: **decisión del propietario transcrita por la sesión autora.** El repositorio no puede verificarla (misma limitación que ADR-0008, ADR-0009 y ADR-0014).
Fecha de la decisión: 2026-10-14 05:36 UTC, en el hilo del proyecto.
Decisor: Alei Ruiz (propietario).

Texto literal del propietario, ante la pregunta de qué herramienta de IaC usar para poder montar OPSLOG solo en la cuenta de cada cliente:

> "terraform."

Compatible con SPEC-1.4 y ORCH-1.4. No modifica `SPECS.md`, `Orchestrator.md` ni `docs/baselines/**`; **sustituye** únicamente la mención «CDK TypeScript para IaC» de SPECS §3 y la consecuencia «La IaC (CDK)» de ADR-0012, por el mecanismo de sucesión que ADR-0012 ya prevé.

## Contexto

El objetivo de negocio (2026-10-14) es **vender** OPSLOG, no operarlo: cada cliente lo ejecuta en su propia cuenta de AWS. Eso exige un despliegue repetible, parametrizable por cliente y revisable antes de aplicar. SPECS §3 y ADR-0012 asumían CDK en TypeScript.

## Decisión

1. La IaC de OPSLOG es **Terraform** (HCL), en `infra/terraform/`. CDK TypeScript queda descartado.
2. Se mantiene el modelo de etapas de ADR-0012: la etapa y los interruptores de componentes son variables, de modo que subir de etapa es un cambio de configuración.
3. El repositorio no contiene identificadores de cuenta, nombres de bucket reales, regiones fijas ni secretos: todo entra por variables. El backend de estado es configurable por el operador (`-backend-config`), no está fijado en el código.
4. Los recursos creados a mano en la cuenta de demostración se incorporan con `terraform import`, no se recrean (ver `infra/terraform/README.md`).
5. CI solo ejecuta `terraform fmt -check` y `terraform validate` sobre el módulo. Ningún flujo hace `plan`/`apply` contra una cuenta real; aplicar siempre lo decide una persona.
6. Todo lo demás de ADR-0012 (etapas, guardarraíles de costo, etiquetas obligatorias, AWS Budgets, «ningún recurso sin aprobación») sigue vigente. Este ADR no autoriza aprovisionar nada.

## Alternativas consideradas

- **CDK TypeScript (SPECS §3):** encaja con el lenguaje del monorepo, pero entrega a cada cliente un proyecto Node con toolchain propio y un paso de síntesis; Terraform es un binario único, más habitual en equipos de operaciones de clientes y con `plan` legible como paso de aprobación. Descartado por el propietario.
- **CloudFormation plano:** sin dependencias, pero sin módulos ni `import` ergonómicos. Descartado.

## Consecuencias

- `infra/terraform/` pasa a ser la única fuente de infraestructura; los textos de SPECS §3 e `infra/plan/AWS.md` que mencionen CDK se leen como Terraform hasta que una versión posterior de SPECS los actualice.
- Sin credenciales AWS en CI no hay `plan` automático; la validación contra una cuenta es manual.
- El estado de Terraform contiene datos sensibles: debe guardarse en un backend cifrado y con acceso restringido, nunca en el repositorio.
