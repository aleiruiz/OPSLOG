import type { IncidentCommand } from '../../../../../packages/domain/incidents/cases/src/index.js';
import type {
  IncidentProcessService,
  IncidentWorkflowService,
} from '../../../../../packages/domain/incidents/workflow/src/index.js';
import type { IncidentApiDeps } from '../../cases/src/index.js';

export interface IncidentWorkflowApiDeps extends IncidentApiDeps {
  readonly workflow: IncidentWorkflowService;
  readonly process: IncidentProcessService;
}

export interface NextStepView {
  readonly command: IncidentCommand;
  /** Stable ids of what the case still lacks for the command; empty when it could run now. */
  readonly missingRequirements: readonly string[];
}
export interface NextStepsView {
  readonly items: readonly NextStepView[];
}
