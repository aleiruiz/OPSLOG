import type {
  RepairLinkService,
  RepairLinkView,
} from '../../../../../packages/domain/incidents/repairs/src/index.js';
import type { PersonRef, SessionDeps } from '../../cases/src/index.js';

export interface IncidentRepairApiDeps extends SessionDeps {
  readonly repairs: RepairLinkService;
  readonly labels: {
    /** `actorId` is `user-<subject>`. */
    member(tenantId: string, actorId: string): Promise<string>;
  };
}

/** A link as the browser reads it: the order's state and workshop name, never an amount. */
export interface RepairLinkItemView extends Omit<RepairLinkView, 'linkedBy'> {
  readonly linkedBy: PersonRef;
}
export interface RepairLinkListView {
  readonly items: readonly RepairLinkItemView[];
}
export interface RepairLinkChangeView {
  /** The version of the case after the command. */
  readonly version: number;
  readonly item: RepairLinkItemView;
}
export interface RepairUnlinkView {
  readonly version: number;
}
