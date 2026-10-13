import {
  INCIDENT_ASSIGNED_EVENT,
  INCIDENT_CANCELLED_EVENT,
  INCIDENT_CLOSED_EVENT,
  INCIDENT_REOPENED_EVENT,
  INCIDENT_UPDATED_EVENT,
  INCIDENT_STATUS_CHANGED_EVENT,
  IncidentError,
  RULES,
  assertNotTerminal,
  payloadHash,
  type IdempotencyRecord,
  type Incident,
  type IncidentActor,
  type IncidentCommand,
  type IncidentEvent,
  type IncidentStore,
} from '../../cases/src/index.js';
import { allowedCommands, mayRun } from './access.js';
import { closureOf, inTransaction } from './closing.js';
import { IDEMPOTENCY_REQUIRED_COMMANDS, transitionAllowed } from './commands.js';
import { effectOf, changedFieldsOf } from './effects.js';
import { WorkflowBase, type WorkflowOptions } from './base.js';
import { FactLoader } from './facts.js';
import { parseCommand, type ParsedCommand } from './input.js';
import type { WorkflowPorts } from './ports.js';
import { missingRequirements } from './requirements.js';

/** What a caller still has to do before a command can run (SPECS §6, US-032). */
export interface NextStep {
  readonly command: IncidentCommand;
  readonly missingRequirements: readonly string[];
}

/** The permission a responsible needs: to see and to manage cases (SPECS §6.2, ADR-0014). */
const RESPONSIBLE_PERMISSIONS = ['incidents:view', 'incidents:edit'] as const;

function eventOf(command: IncidentCommand, written: Incident): IncidentEvent {
  const base = { incidentId: written.id, version: written.version };
  if (command === 'assign') return { type: INCIDENT_ASSIGNED_EVENT, payload: base };
  if (command === 'cancel') return { type: INCIDENT_CANCELLED_EVENT, payload: base };
  if (command === 'close')
    return { type: INCIDENT_CLOSED_EVENT, payload: { ...base, vehicleId: written.vehicleId } };
  if (command === 'reopen')
    return { type: INCIDENT_REOPENED_EVENT, payload: { ...base, cycle: written.cycle } };
  // An approval changes the case without changing its status.
  if (command === 'approve_assumption' || command === 'approve_close')
    return { type: INCIDENT_UPDATED_EVENT, payload: base };
  return {
    type: INCIDENT_STATUS_CHANGED_EVENT,
    payload: { ...base, vehicleId: written.vehicleId, status: written.status },
  };
}

/**
 * The state commands of SPECS §6.2 (INC-WORKFLOW PR 1): the only way a case changes `status`. Each
 * command checks the caller, the state and the route of the type, the version, and then every
 * requirement at once, and writes the case, the timeline, the audit and the event in one transaction.
 */
export class IncidentWorkflowService extends WorkflowBase {
  public constructor(store: IncidentStore, ports: WorkflowPorts, options: WorkflowOptions = {}) {
    super(store, ports, options);
  }

  /** The commands the caller may run now, each with what the case still lacks. Empty without the rights. */
  public async nextSteps(
    tenantId: string,
    actor: IncidentActor,
    id: string,
  ): Promise<readonly NextStep[]> {
    const incident = await this.visible(tenantId, actor, id);
    const loader = new FactLoader(this.ports, this.store, tenantId, incident);
    const steps: NextStep[] = [];
    for (const command of allowedCommands(incident, actor))
      steps.push({
        command,
        missingRequirements: missingRequirements(
          command,
          incident,
          await loader.forCommand(command),
        ),
      });
    return steps;
  }

  /** The stored result of a key already used by this caller for this command, when it is still live. */
  private async replay(
    tenantId: string,
    actor: IncidentActor,
    command: IncidentCommand,
    key: string,
    hash: string,
  ): Promise<Incident | null> {
    const record: IdempotencyRecord | null = await this.store.idempotency(
      tenantId,
      actor.id,
      command,
      key,
    );
    if (!record || record.expiresAt <= this.now().toISOString()) return null;
    if (record.payloadHash !== hash) throw new IncidentError('idempotency_conflict');
    return record.response;
  }

  /**
   * Runs a command. The same key and body replay the stored result without running again, whatever
   * the version is by now; the same key with another body is an `idempotency_conflict`. Without a
   * key the command runs as usual, except the money-bearing ones, which need it.
   */
  public async execute(
    tenantId: string,
    actor: IncidentActor,
    id: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<Incident> {
    const parsed = parseCommand(input);
    const key = this.keyOf(idempotencyKey);
    if (key === undefined && IDEMPOTENCY_REQUIRED_COMMANDS.includes(parsed.command))
      throw new IncidentError('idempotency_key_required');
    const incident = await this.visible(tenantId, actor, id);
    if (!mayRun(actor, incident, parsed.command)) throw new IncidentError('forbidden');
    const hash = payloadHash(incident.id, parsed.command, input);
    if (key !== undefined) {
      const stored = await this.replay(tenantId, actor, parsed.command, key, hash);
      if (stored) return stored;
    }
    try {
      return await this.run(
        tenantId,
        actor,
        incident,
        parsed,
        key === undefined ? undefined : { key, hash },
      );
    } catch (error) {
      // A twin with the same key may have won the race: its result is the answer.
      if (
        key !== undefined &&
        error instanceof IncidentError &&
        error.code !== 'idempotency_conflict'
      ) {
        const winner = await this.replay(tenantId, actor, parsed.command, key, hash);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async run(
    tenantId: string,
    actor: IncidentActor,
    incident: Incident,
    parsed: ParsedCommand,
    keyed: { readonly key: string; readonly hash: string } | undefined,
  ): Promise<Incident> {
    const { command } = parsed;
    // A closed case accepts only `reopen`; the table says so, and a cancelled one accepts nothing.
    if (incident.status === 'cancelled' || command !== 'reopen') assertNotTerminal(incident.status);
    if (!transitionAllowed(incident, command)) throw new IncidentError('invalid_transition');
    if (incident.version !== parsed.version) throw new IncidentError('stale_version');
    const facts = await new FactLoader(this.ports, this.store, tenantId, incident).forCommand(
      command,
    );
    const missing = missingRequirements(command, incident, facts, parsed);
    // The vehicle cannot return to `active` while another cause holds it (D11): a rule, not a gap.
    if (missing.includes('vehicle_blocked'))
      throw new IncidentError('rule_violation', [], RULES.vehicleBlocked);
    if (missing.length > 0) throw new IncidentError('missing_requirements', [], null, missing);
    const responsible =
      command === 'assign'
        ? await this.responsible(tenantId, parsed.responsibleId as string)
        : null;
    if (command === 'assign' && responsible === incident.responsibleId) return incident;
    // Recording an approval that already stands changes nothing.
    if (command === 'approve_assumption' && incident.assumptionApproval !== null) return incident;
    if (command === 'approve_close' && incident.closeApproval !== null) return incident;
    const time = this.now().toISOString();
    const changes = effectOf(command, incident, {
      time,
      actor,
      responsibleId: responsible,
      reason: parsed.reason,
    });
    const closure = command === 'close' ? closureOf(incident, facts, { time, actor }) : null;
    const extra = inTransaction(command, this.ports, incident, closure);
    return this.commit({
      tenantId,
      actor,
      incident,
      next: { ...incident, ...changes },
      ...(extra ? { extra } : {}),
      command,
      changed: changedFieldsOf(incident, changes),
      comment: parsed.comment ?? parsed.reason,
      event: (written) => eventOf(command, written),
      ...(keyed ? { claim: this.claim(actor, command, keyed.key, incident, keyed.hash) } : {}),
    });
  }

  /** A member of this tenant who may see and manage cases; anyone else is unknown (404) or not eligible (422). */
  private async responsible(tenantId: string, memberId: string): Promise<string> {
    const permissions = await this.ports.members.permissionsOf(tenantId, memberId);
    if (permissions === null) throw new IncidentError('not_found');
    if (!RESPONSIBLE_PERMISSIONS.every((permission) => permissions.includes(permission)))
      throw new IncidentError('rule_violation', [], RULES.responsibleNotEligible);
    return `user-${memberId}`;
  }
}
