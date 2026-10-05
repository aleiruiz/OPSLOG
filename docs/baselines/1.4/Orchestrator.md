# OPSLOG — ORCH-1.4: modelos Claude por rol y revisión Opus

Fecha: 2026-10-05. Sucesora acotada adoptada por instrucción directa del usuario. Hereda ORCH-1.0 a ORCH-1.3 y aplica SPEC-1.4; solo cambia los pines de modelo Claude.

- Con Claude activo, las sesiones de autor, integración y reparación usan `claude-sonnet-5-5` explícito. Las sesiones de investigación y la sesión auditora de cada PR usan `claude-opus-5-5` explícito. No hay fallback ni alias; sin modelo verificable la asignación queda bloqueada.
- La sesión auditora Opus 5.5 hace la revisión de código del PR y es la única auditoría independiente por headSHA del ciclo autónomo (paso 5 de ORCH-1.3). El coordinador no lanza una segunda auditoría ni revisión local adicional.
- Antes de fusionar, el coordinador relee head/base, exige CI requerido exitoso sobre el SHA vigente y un veredicto pass/Good de una sesión `claude-opus-5-5` distinta del autor, con hallazgos resueltos. Un candidato sin revisión Opus sobre su SHA exacto no se fusiona. Una revisión de un SHA anterior no se reutiliza.
- `validateCandidate` del runtime compara el modelo observado de la auditoría contra el pin de auditoría del proveedor activo (`claude-opus-5-5` para Claude, `gpt-6-luna` para Codex).
- Los snapshots y evidencia previos conservan el modelo observado. Las nuevas asignaciones y revalidaciones usan estos pines.
