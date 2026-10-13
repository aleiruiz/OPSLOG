import type { IncidentSlaReader } from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { SessionDeps } from '../../cases/src/index.js';

export interface IncidentSlaApiDeps extends SessionDeps {
  readonly reader: Pick<IncidentSlaReader, 'alerts'>;
}
