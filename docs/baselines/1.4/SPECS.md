# OPSLOG — SPEC-1.4: modelos Claude por rol y revisión de código con Opus

Fecha: 2026-10-05. Sucesora acotada adoptada por instrucción directa del usuario; hereda SPEC-1.0 a SPEC-1.3 salvo el cambio de pines de modelo Claude.

Durante Claude como proveedor activo: código con `claude-sonnet-5-5`; investigación y revisión de código con `claude-opus-5-5`. Cada PR exige, antes de fusionarse, una revisión de código por un agente `claude-opus-5-5` externo al autor, sobre el headSHA vigente. Esa revisión es la única auditoría independiente por PR/SHA de SPEC-1.3: no se duplica ni se sustituye por una review formal de GitHub. Un cambio de código invalida la revisión y exige una nueva sobre el SHA nuevo. Los hallazgos se resuelven antes de fusionar.

Se fija y observa el modelo al lanzar; si no puede fijarse o comprobarse, la asignación queda bloqueada, sin fallback. El pin de Codex (`gpt-6-luna`), proveedor único activo, CI, aislamiento, trazabilidad, gates G0–G5 y AWS diferido no cambian. Esta sucesora no declara ningún gate aprobado.
