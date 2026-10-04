import type { Meta, StoryObj } from '@storybook/react';
import { UiState, UiStateKind } from './UiState';
const meta = {
  title: 'Foundations/Estados de interfaz',
  component: UiState,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof UiState>;
export default meta;
type Story = StoryObj<typeof meta>;
const story = (kind: UiStateKind): Story => ({
  args: {
    kind,
    ...(kind === 'error' ? { actionLabel: 'Reintentar', onAction: () => {} } : {}),
  },
});
export const Loading = story('loading');
export const Empty = story('empty');
export const NoResults = story('no-results');
export const Error = story('error');
export const NoPermission = story('no-permission');
export const Incomplete = story('incomplete');
export const Expired = story('expired');
export const Closed = story('closed');
export const Success = story('success');
export const SessionExpired = story('session-expired');
