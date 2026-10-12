/** What a work draft is made of: tasks as one description per line, parts as editable rows. */
export interface DraftPart {
  readonly id: string | undefined;
  readonly name: string;
  readonly quantity: string;
}
export interface WorkDraft {
  readonly tasks: string;
  readonly parts: readonly DraftPart[];
}
/** The server's tasks and parts at one version. */
export interface WorkSnapshot {
  readonly tasks: readonly { readonly id: string; readonly description: string }[];
  readonly parts: readonly {
    readonly id: string;
    readonly name: string;
    readonly quantity: string;
  }[];
}
export interface Rebased {
  readonly draft: WorkDraft;
  /** Plain-language account of what other people changed, for the person to review before saving. */
  readonly changes: readonly string[];
}

export const draftOf = (snapshot: WorkSnapshot): WorkDraft => ({
  tasks: snapshot.tasks.map((task) => task.description).join('\n'),
  parts: snapshot.parts.map((part) => ({
    id: part.id as string | undefined,
    name: part.name,
    quantity: part.quantity,
  })),
});

export const taskLines = (tasks: string): string[] =>
  tasks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Three-way merge of an unsent draft onto a newer server version: `base` is what the draft started
 * from, `server` what the order holds now. The person's removals, additions and edits are kept,
 * work other people added concurrently is never dropped, and every difference is reported.
 */
export function rebaseDraft(base: WorkSnapshot, server: WorkSnapshot, draft: WorkDraft): Rebased {
  const changes: string[] = [];
  const lineList = taskLines(draft.tasks);
  const lines = new Set(lineList);
  const baseTasks = new Set(base.tasks.map((task) => task.description));
  const serverTasks = server.tasks;
  const serverNames = new Set(serverTasks.map((task) => task.description));
  const removedByUser = new Set([...baseTasks].filter((description) => !lines.has(description)));
  // A list, not a set: lines the person typed twice stay twice, as they would on a plain save.
  const addedByUser = lineList.filter((description) => !baseTasks.has(description));
  for (const task of serverTasks)
    if (!baseTasks.has(task.description))
      changes.push(`Otra persona agregó el trabajo «${task.description}».`);
  for (const description of baseTasks)
    if (!serverNames.has(description) && !removedByUser.has(description))
      changes.push(`Otra persona quitó el trabajo «${description}»; ya no está en tu borrador.`);
  const tasks = [
    ...serverTasks.map((task) => task.description).filter((d) => !removedByUser.has(d)),
    ...addedByUser.filter((description) => !serverNames.has(description)),
  ];

  const baseParts = new Map(base.parts.map((part) => [part.id, part]));
  const draftParts = new Map(
    draft.parts.flatMap((part) => (part.id === undefined ? [] : [[part.id, part] as const])),
  );
  const differs = (
    a: { name: string; quantity: string },
    b: { name: string; quantity: string } | undefined,
  ) =>
    b === undefined || a.name.trim() !== b.name.trim() || a.quantity.trim() !== b.quantity.trim();
  const parts: DraftPart[] = [];
  const serverIds = new Set(server.parts.map((part) => part.id));
  for (const current of server.parts) {
    const original = baseParts.get(current.id);
    const mine = draftParts.get(current.id);
    if (original === undefined) {
      changes.push(`Otra persona agregó la refacción «${current.name}».`);
      parts.push({ ...current });
    } else if (mine === undefined) {
      // The person removed it: their removal stands, but say so when someone else changed it.
      if (differs(current, original))
        changes.push(
          `Otra persona cambió la refacción «${current.name}», que quitaste; se mantiene quitada.`,
        );
    } else if (differs(mine, original)) {
      if (differs(current, original))
        changes.push(
          `Otra persona también cambió la refacción «${current.name}»; se conserva tu cambio.`,
        );
      parts.push(mine);
    } else {
      if (differs(current, original))
        changes.push(`Otra persona actualizó la refacción «${current.name}».`);
      parts.push({ ...current });
    }
  }
  for (const original of base.parts) {
    if (serverIds.has(original.id)) continue;
    const mine = draftParts.get(original.id);
    if (mine !== undefined && differs(mine, original)) {
      changes.push(
        `Otra persona quitó la refacción «${original.name}»; tu versión editada se conserva como nueva.`,
      );
      parts.push({ ...mine, id: undefined });
    } else if (mine !== undefined)
      changes.push(
        `Otra persona quitó la refacción «${original.name}»; ya no está en tu borrador.`,
      );
  }
  // A new row is dropped only when someone else concurrently added the same part (not a base part).
  for (const mine of draft.parts)
    if (
      mine.id === undefined &&
      !server.parts.some((part) => !baseParts.has(part.id) && !differs(part, mine))
    )
      parts.push(mine);
  return { draft: { tasks: tasks.join('\n'), parts }, changes };
}
