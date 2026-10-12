import { randomUUID } from 'node:crypto';

export interface WorkshopInput {
  readonly name: string;
  readonly specialties: readonly string[];
  readonly contact: string | null;
}
export interface Workshop extends WorkshopInput {
  readonly id: string;
  readonly tenantId: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface WorkshopStore {
  create(value: Workshop, actorId: string): Promise<void>;
  get(tenantId: string, id: string): Promise<Workshop | null>;
  list(tenantId: string): Promise<readonly Workshop[]>;
  update(value: Workshop, actorId: string): Promise<boolean>;
}

export function validateWorkshopInput(input: unknown): WorkshopInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_input');
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !['name', 'specialties', 'contact'].includes(key)) ||
    typeof v['name'] !== 'string' ||
    !v['name'].trim() ||
    v['name'].trim().length > 120 ||
    !Array.isArray(v['specialties']) ||
    !v['specialties'].every(
      (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 80,
    ) ||
    (v['contact'] !== undefined &&
      v['contact'] !== null &&
      (typeof v['contact'] !== 'string' || v['contact'].length > 254))
  )
    throw new Error('invalid_input');
  return {
    name: v['name'].trim(),
    specialties: [...new Set((v['specialties'] as string[]).map((s) => s.trim()))],
    contact: (v['contact'] as string | null | undefined) ?? null,
  };
}

export class WorkshopService {
  public constructor(
    private readonly store: WorkshopStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}
  public async create(tenantId: string, actorId: string, input: unknown): Promise<Workshop> {
    const time = this.now().toISOString();
    const value: Workshop = {
      ...validateWorkshopInput(input),
      id: this.newId(),
      tenantId,
      active: true,
      createdAt: time,
      updatedAt: time,
    };
    await this.store.create(value, actorId);
    return value;
  }
  public async get(tenantId: string, id: string): Promise<Workshop> {
    const result = await this.store.get(tenantId, id);
    if (!result) throw new Error('not_found');
    return result;
  }
  public list(tenantId: string): Promise<readonly Workshop[]> {
    return this.store.list(tenantId);
  }
  public async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: unknown,
  ): Promise<Workshop> {
    const current = await this.get(tenantId, id);
    const next = {
      ...current,
      ...validateWorkshopInput(input),
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.store.update(next, actorId))) throw new Error('not_found');
    return next;
  }
  public async deactivate(tenantId: string, actorId: string, id: string): Promise<Workshop> {
    const current = await this.get(tenantId, id);
    const next = { ...current, active: false, updatedAt: this.now().toISOString() };
    if (!(await this.store.update(next, actorId))) throw new Error('not_found');
    return next;
  }
}

export class InMemoryWorkshopStore implements WorkshopStore {
  private readonly values = new Map<string, Workshop>();
  private key(tenantId: string, id: string): string {
    return `${tenantId.length}:${tenantId}${id}`;
  }
  public async create(value: Workshop, _actorId: string): Promise<void> {
    this.values.set(this.key(value.tenantId, value.id), structuredClone(value));
  }
  public async get(tenantId: string, id: string): Promise<Workshop | null> {
    const value = this.values.get(this.key(tenantId, id));
    return value ? structuredClone(value) : null;
  }
  public async list(tenantId: string): Promise<readonly Workshop[]> {
    return [...this.values.values()]
      .filter((v) => v.tenantId === tenantId)
      .map((v) => structuredClone(v));
  }
  public async update(value: Workshop, _actorId: string): Promise<boolean> {
    const key = this.key(value.tenantId, value.id);
    if (!this.values.has(key)) return false;
    this.values.set(key, structuredClone(value));
    return true;
  }
}
