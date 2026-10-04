import type { Meta, StoryObj } from '@storybook/react';
import { StatusBadge } from './StatusBadge';
const meta = {
  title: 'Foundations/Estado y severidad',
  component: StatusBadge,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof StatusBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = { args: { label: 'Activo', tone: 'success' } };
export const Warning: Story = {
  args: { label: 'Requiere atención', tone: 'warning', severity: 'Alta' },
};
export const Expired: Story = {
  args: { label: 'Vencido', tone: 'danger', description: 'Requiere renovación.' },
};
