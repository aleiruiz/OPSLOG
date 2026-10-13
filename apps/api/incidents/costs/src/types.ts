import type { IncidentCostService } from '../../../../../packages/domain/incidents/costs/src/index.js';
import type { SessionDeps } from '../../cases/src/index.js';

export interface IncidentCostApiDeps extends SessionDeps {
  readonly costs: IncidentCostService;
}
