import type { RecoveryNotifier } from '../../../../../packages/domain/identity/src/index.js';

/** The recovery notifier of a composition that was given none: asking for one fails loudly. */
export const unconfiguredRecoveryNotifier: RecoveryNotifier = {
  deliver: async () => {
    throw new Error('recovery notifier is not configured');
  },
};
