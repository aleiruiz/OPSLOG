import { WorkOrderError } from './errors.js';
import {
  MAX_COSTS,
  MAX_PARTS,
  MAX_TASKS,
  costCategory,
  list,
  money,
  optionalId,
  optionalText,
  quantity,
  record,
  text,
  version,
} from './rules.js';
import type { WorkOrder, WorkOrderCost, WorkOrderPart, WorkOrderTask } from './types.js';

export interface ParsedEdit {
  readonly version: number;
  readonly changes: Partial<WorkOrder>;
}

const idOf = (value: unknown, known: ReadonlySet<string>, newId: () => string): string => {
  const id = optionalId(value);
  if (id === null) return newId();
  if (!known.has(id)) throw new WorkOrderError('invalid_input');
  return id;
};
const unique = <T extends { readonly id: string }>(items: readonly T[]): readonly T[] => {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new WorkOrderError('invalid_input');
  return items;
};

/**
 * Work facts recorded by the fleet or the assigned mechanic: description, tasks and parts. Known
 * part ids keep their unit cost, which only the cost command (with `view_costs`) can change.
 */
export function parseWork(input: unknown, order: WorkOrder, newId: () => string): ParsedEdit {
  const data = record(input, ['version', 'description', 'tasks', 'parts']);
  const knownTasks = new Set(order.tasks.map((task) => task.id));
  const knownParts = new Map(order.parts.map((part) => [part.id, part]));
  const tasks: WorkOrderTask[] = list(data['tasks'] ?? [], MAX_TASKS).map((value) => {
    const task = record(value, ['id', 'description']);
    return { id: idOf(task['id'], knownTasks, newId), description: text(task['description'], 500) };
  });
  const parts: WorkOrderPart[] = list(data['parts'] ?? [], MAX_PARTS).map((value) => {
    const part = record(value, ['id', 'name', 'quantity']);
    const id = idOf(part['id'], new Set(knownParts.keys()), newId);
    return {
      id,
      name: text(part['name'], 200),
      quantity: quantity(part['quantity']),
      unitCost: knownParts.get(id)?.unitCost ?? null,
    };
  });
  return {
    version: version(data['version']),
    changes: {
      description:
        data['description'] === undefined
          ? order.description
          : optionalText(data['description'], 2000),
      tasks: unique(tasks),
      parts: unique(parts),
    },
  };
}

/** Costs and part unit costs: exact integers in the minor unit with their ISO currency. */
export function parseCosts(input: unknown, order: WorkOrder, newId: () => string): ParsedEdit {
  const data = record(input, ['version', 'costs', 'partCosts']);
  const knownCosts = new Set(order.costs.map((cost) => cost.id));
  const costs: WorkOrderCost[] = list(data['costs'] ?? [], MAX_COSTS).map((value) => {
    const cost = record(value, ['id', 'category', 'amount']);
    return {
      id: idOf(cost['id'], knownCosts, newId),
      category: costCategory(cost['category']),
      amount: money(cost['amount']),
    };
  });
  const unitCosts = new Map<string, WorkOrderPart['unitCost']>();
  for (const value of list(data['partCosts'] ?? [], MAX_PARTS)) {
    const entry = record(value, ['partId', 'unitCost']);
    const partId = optionalId(entry['partId']);
    if (partId === null || unitCosts.has(partId) || !order.parts.some((p) => p.id === partId))
      throw new WorkOrderError('invalid_input');
    unitCosts.set(partId, entry['unitCost'] === null ? null : money(entry['unitCost']));
  }
  return {
    version: version(data['version']),
    changes: {
      costs: unique(costs),
      parts: order.parts.map((part) =>
        unitCosts.has(part.id) ? { ...part, unitCost: unitCosts.get(part.id) ?? null } : part,
      ),
    },
  };
}
