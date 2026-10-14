import { WorkOrderError } from './errors.js';
import { WorkOrderFilesBase } from './files.js';
import {
  IDEMPOTENCY_REQUIRED_COMMANDS,
  idempotencyKey,
  payloadHash,
  type IdempotencyClaim,
} from './idempotency.js';
import { opaqueId } from './rules.js';
import type { WorkOrder, WorkOrderCommand } from './types.js';
import { requireCommand, type WorkOrderActor } from './workflow.js';

/** Service methods of the status commands, by the command they apply. */
export const COMMAND_METHODS = {
  assign: 'assign',
  start: 'start',
  complete: 'complete',
  approve_close: 'approveClose',
  close: 'close',
  cancel: 'cancel',
  reopen: 'reopen',
} as const satisfies Record<WorkOrderCommand, string>;

type CommandArgs = [
  tenantId: string,
  actor: WorkOrderActor,
  id: string,
  input: unknown,
  claim?: IdempotencyClaim,
];

/** Status commands under an Idempotency-Key; the concrete commands live in `WorkOrderService`. */
export abstract class IdempotentCommands extends WorkOrderFilesBase {
  public abstract assign(...args: CommandArgs): Promise<WorkOrder>;
  public abstract start(...args: CommandArgs): Promise<WorkOrder>;
  public abstract complete(...args: CommandArgs): Promise<WorkOrder>;
  public abstract approveClose(...args: CommandArgs): Promise<WorkOrder>;
  public abstract close(...args: CommandArgs): Promise<WorkOrder>;
  public abstract cancel(...args: CommandArgs): Promise<WorkOrder>;
  public abstract reopen(...args: CommandArgs): Promise<WorkOrder>;
  /** `claim` builds the key claim once the new order's id is known. */
  public abstract createCorrective(
    tenantId: string,
    actor: WorkOrderActor,
    input: unknown,
    claim?: (orderId: string) => IdempotencyClaim,
  ): Promise<WorkOrder>;

  /**
   * Creates a corrective order under an optional Idempotency-Key: the same key and body replay the
   * order created the first time (no second order), another body is an `idempotency_conflict`.
   * The key is scoped to the tenant and the actor, like the status commands'.
   */
  public async createKeyed(
    tenantId: string,
    actor: WorkOrderActor,
    input: unknown,
    key?: string,
  ): Promise<WorkOrder> {
    if (key === undefined) return this.createCorrective(tenantId, actor, input);
    if (!actor.permissions.includes('create')) throw new WorkOrderError('forbidden');
    const claimKey = idempotencyKey(key);
    const hash = payloadHash('create', 'create', input);
    const replay = async (): Promise<WorkOrder | null> => {
      const record = await this.store.idempotency(tenantId, actor.id, 'create', claimKey);
      if (!record || record.expiresAt <= this.now().toISOString()) return null;
      if (record.payloadHash !== hash) throw new WorkOrderError('idempotency_conflict');
      // The caller must still see the order; costs follow the view.
      await this.get(tenantId, actor, record.orderId);
      return record.response;
    };
    const stored = await replay();
    if (stored) return stored;
    const createdAt = this.now();
    try {
      return await this.createCorrective(tenantId, actor, input, (orderId) => ({
        actorId: actor.id,
        command: 'create',
        key: claimKey,
        orderId,
        payloadHash: hash,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.idempotencyTtlMs).toISOString(),
      }));
    } catch (error) {
      // A concurrent duplicate lost the race: the winner's order is stored, so it replays that one.
      if (error instanceof WorkOrderError && !error.code.startsWith('idempotency_')) {
        const winner = await replay();
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * Runs a status command under an Idempotency-Key (SPECS:195). The same key and payload replay the
   * stored result without executing again, whatever the order version is by now; the same key with
   * another payload is an `idempotency_conflict`. Without a key the command runs as usual.
   */
  public async execute(
    tenantId: string,
    actor: WorkOrderActor,
    command: WorkOrderCommand,
    id: string,
    input: unknown,
    key?: string,
  ): Promise<WorkOrder> {
    const method = COMMAND_METHODS[command];
    if (key === undefined) {
      // Closing and reopening move money-bearing state: no key, no command.
      if (IDEMPOTENCY_REQUIRED_COMMANDS.includes(command))
        throw new WorkOrderError('idempotency_key_required');
      return this[method](tenantId, actor, id, input);
    }
    const orderId = opaqueId(id);
    const claimKey = idempotencyKey(key);
    const hash = payloadHash(orderId, command, input);
    const replay = () => this.replay(tenantId, actor, command, orderId, claimKey, hash);
    const stored = await replay();
    if (stored) return stored;
    const createdAt = this.now();
    const claim: IdempotencyClaim = {
      actorId: actor.id,
      command,
      key: claimKey,
      orderId,
      payloadHash: hash,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.idempotencyTtlMs).toISOString(),
    };
    try {
      return await this[method](tenantId, actor, id, input, claim);
    } catch (error) {
      // A concurrent duplicate lost the race: its result is now stored, so it replays that one. The
      // loser may fail on the version, or on the state the winner left (closed, already approved).
      if (error instanceof WorkOrderError && !error.code.startsWith('idempotency_')) {
        const winner = await replay();
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async replay(
    tenantId: string,
    actor: WorkOrderActor,
    command: WorkOrderCommand,
    orderId: string,
    key: string,
    hash: string,
  ): Promise<WorkOrder | null> {
    const record = await this.store.idempotency(tenantId, actor.id, command, key);
    if (!record || record.expiresAt <= this.now().toISOString()) return null;
    if (record.payloadHash !== hash || record.orderId !== orderId)
      throw new WorkOrderError('idempotency_conflict');
    // The caller must still see the order and hold the command's permission; costs follow the view.
    requireCommand(actor, command, await this.get(tenantId, actor, orderId));
    return record.response;
  }
}
