import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './BaseComponents';
import { CheckField } from './CheckField';
import { FileButton } from './FileButton';
import { InlineAlert } from './InlineAlert';

const meta = {
  title: 'Foundations/Avisos y controles de formulario',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Alerts: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <InlineAlert severity="success">Cambios guardados.</InlineAlert>
      <InlineAlert severity="info">El caso espera la revisión de los archivos.</InlineAlert>
      <InlineAlert
        severity="warning"
        title="El caso cambió"
        action={<Button color="inherit">Recargar</Button>}
      >
        Otra persona lo editó mientras escribías. Tus cambios siguen en el formulario.
      </InlineAlert>
      <InlineAlert severity="error">No pudimos guardar. Intenta nuevamente.</InlineAlert>
    </div>
  ),
};

export const ChecksAndFiles: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
      <CheckField label="Frente" checked onChange={() => undefined} />
      <CheckField label="Parte trasera" checked={false} onChange={() => undefined} />
      <CheckField
        label="Techo (no disponible)"
        checked={false}
        disabled
        onChange={() => undefined}
      />
      <FileButton
        label="Tomar foto"
        capture="environment"
        accept="image/*"
        onFiles={() => undefined}
      />
      <FileButton label="Adjuntar archivo" multiple onFiles={() => undefined} />
    </div>
  ),
};
