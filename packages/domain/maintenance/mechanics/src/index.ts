import { randomUUID } from 'node:crypto';

export type MechanicKind = 'internal' | 'external';
export interface MechanicInput {
  readonly name: string;
  readonly specialties: readonly string[];
  readonly contact: string | null;
  readonly kind: MechanicKind;
  readonly workshopId: string | null;
  readonly memberId: string | null;
}
export interface Mechanic extends MechanicInput {
  readonly id: string;
  readonly tenantId: string;
  readonly registeredBy: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MechanicStore {
  create(value: Mechanic, actorId: string): Promise<void>;
  get(tenantId: string, id: string): Promise<Mechanic | null>;
  list(tenantId: string): Promise<readonly Mechanic[]>;
  update(value: Mechanic, actorId: string): Promise<boolean>;
}
export interface MechanicReferences {
  readonly workshops: {
    get(tenantId: string, id: string): Promise<{ readonly active: boolean } | null>;
  };
  readonly isTenantMember: (tenantId: string, memberId: string) => Promise<boolean>;
}

function parse(input: unknown): MechanicInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_input');
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !['name', 'specialties', 'contact', 'kind', 'workshopId', 'memberId'].includes(key),
    ) ||
    typeof v['name'] !== 'string' ||
    !v['name'].trim() ||
    v['name'].length > 120 ||
    !Array.isArray(v['specialties']) ||
    !v['specialties'].every((s) => typeof s === 'string' && s.trim() && s.length <= 80) ||
    !['internal', 'external'].includes(String(v['kind'])) ||
    (v['contact'] !== undefined && v['contact'] !== null && typeof v['contact'] !== 'string')
  )
    throw new Error('invalid_input');
  const kind = v['kind'] as MechanicKind;
  const memberId =
    v['memberId'] === undefined || v['memberId'] === null ? null : String(v['memberId']);
  if ((kind === 'internal') !== (memberId !== null)) throw new Error('invalid_input');
  return {
    name: v['name'].trim(),
    specialties: [...new Set((v['specialties'] as string[]).map((s) => s.trim()))],
    contact: (v['contact'] as string | null | undefined) ?? null,
    kind,
    workshopId:
      v['workshopId'] === undefined || v['workshopId'] === null ? null : String(v['workshopId']),
    memberId,
  };
}

export class MechanicService {
  public constructor(
    private readonly store: MechanicStore,
    private readonly refs: MechanicReferences,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}
  private async validateRefs(tenantId: string, input: MechanicInput): Promise<void> {
    if (input.workshopId) {
      const workshop = await this.refs.workshops.get(tenantId, input.workshopId);
      if (!workshop?.active) throw new Error('invalid_association');
    }
    if (input.memberId && !(await this.refs.isTenantMember(tenantId, input.memberId)))
      throw new Error('invalid_association');
  }
  public async create(tenantId: string, actorId: string, input: unknown): Promise<Mechanic> {
    const parsed = parse(input);
    await this.validateRefs(tenantId, parsed);
    const time = this.now().toISOString();
    const value: Mechanic = {
      ...parsed,
      id: this.newId(),
      tenantId,
      registeredBy: actorId,
      active: true,
      createdAt: time,
      updatedAt: time,
    };
    await this.store.create(value, actorId);
    return value;
  }
  public async get(tenantId: string, id: string): Promise<Mechanic> {
    const value = await this.store.get(tenantId, id);
    if (!value) throw new Error('not_found');
    return value;
  }
  public list(tenantId: string): Promise<readonly Mechanic[]> {
    return this.store.list(tenantId);
  }
  public async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: unknown,
  ): Promise<Mechanic> {
    const current = await this.get(tenantId, id);
    const parsed = parse(input);
    await this.validateRefs(tenantId, parsed);
    if (current.kind !== parsed.kind || current.memberId !== parsed.memberId)
      throw new Error('immutable');
    const next = { ...current, ...parsed, updatedAt: this.now().toISOString() };
    if (!(await this.store.update(next, actorId))) throw new Error('not_found');
    return next;
  }
  public async deactivate(tenantId: string, actorId: string, id: string): Promise<Mechanic> {
    const current = await this.get(tenantId, id);
    const next = { ...current, active: false, updatedAt: this.now().toISOString() };
    if (!(await this.store.update(next, actorId))) throw new Error('not_found');
    return next;
  }
}

export class InMemoryMechanicStore implements MechanicStore {
  private readonly values = new Map<string, Mechanic>();
  private key(tenantId: string, id: string): string {
    return `${tenantId.length}:${tenantId}${id}`;
  }
  public async create(value: Mechanic, _actorId: string): Promise<void> {
    this.values.set(this.key(value.tenantId, value.id), structuredClone(value));
  }
  public async get(tenantId: string, id: string): Promise<Mechanic | null> {
    const value = this.values.get(this.key(tenantId, id));
    return value ? structuredClone(value) : null;
  }
  public async list(tenantId: string): Promise<readonly Mechanic[]> {
    return [...this.values.values()]
      .filter((v) => v.tenantId === tenantId)
      .map((v) => structuredClone(v));
  }
  public async update(value: Mechanic, _actorId: string): Promise<boolean> {
    const key = this.key(value.tenantId, value.id);
    if (!this.values.has(key)) return false;
    this.values.set(key, structuredClone(value));
    return true;
  }
}
