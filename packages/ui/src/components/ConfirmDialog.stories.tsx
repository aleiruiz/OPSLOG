import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Button, PageHeader } from './BaseComponents';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';

const meta = {
  title: 'Foundations/Dialogo de confirmacion',
  component: ConfirmDialog,
  // `harness: 'modal'`: the all-stories axe page skips stories with an open modal (it hides the rest of the page by
  // design); the dialog has its own axe checks (unit and e2e).
  parameters: { layout: 'padded', harness: 'modal' },
  args: {
    title: 'Archivar registro',
    description:
      'El registro dejará de aparecer en los listados. Esta acción no se puede deshacer.',
    confirmLabel: 'Archivar',
    onConfirm: () => undefined,
    onCancel: () => undefined,
  },
  // The dialog renders in a portal: the page behind it is what the story root contains.
  render: (args: ConfirmDialogProps) => (
    <>
      <PageHeader
        title="Registro 042"
        description="Pantalla de fondo de la confirmación."
        actions={<Button variant="outlined">Archivar</Button>}
      />
      <ConfirmDialog {...args} />
    </>
  ),
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Busy: Story = { args: { busy: true } };
export const WithError: Story = {
  args: {
    error: 'El registro cambió mientras lo revisabas.',
    errorActionLabel: 'Recargar datos',
    onErrorAction: () => undefined,
  },
};
