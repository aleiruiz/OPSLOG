import React from 'react';
import { PageHeader, UiState } from '@opslog/ui';
import { AreaForm, type AreaFormProps } from './AreaForm';
import { AreaNotEditable, AreaNotFound } from './AreaMessages';
import { demoAreas } from './fixtures';
import { emptyValues, valuesOf, type AreaFormValues } from './formModel';
import { describeFailure } from './messages';
import { Frame, noop } from './storyFrame';
import { buildTree, findNode, parentChoices } from './tree';

export default {
  title: 'Plantilla/Areas/Formulario',
  parameters: { layout: 'padded' },
};

const areas = demoAreas();
const tree = buildTree(areas);
const area = areas.find((item) => item.id === 'area-norte-mty')!;
const node = findNode(tree, area.id)!;
const createChoices = parentChoices(tree, null);
const moveChoices = parentChoices(tree, node);

const header = (title: string, description: string) => (
  <PageHeader title={title} description={description} />
);
const createHeader = header(
  'Nueva área',
  'El área se crea activa. Elige dónde va en la estructura y quiénes la atienden.',
);

const create = (props: Partial<AreaFormProps> = {}) => (
  <Frame>
    {createHeader}
    <AreaForm
      mode="create"
      choices={createChoices}
      cancelTo="/plantilla/areas"
      currentUserId="admin"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);

const edit = (props: Partial<AreaFormProps> = {}) => (
  <Frame>
    {header(
      'Editar área',
      'Los cambios se guardan sobre la versión que cargaste; si otra persona cambia el área antes, te avisaremos. Para cambiar su ubicación usa «Mover».',
    )}
    <AreaForm
      mode="edit"
      initial={valuesOf(area)}
      cancelTo="/plantilla/areas/area-norte-mty"
      currentUserId="viewer"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);

const move = (props: Partial<AreaFormProps> = {}) => (
  <Frame>
    {header(
      'Mover área',
      'Cambia el área superior. La estructura de sus sub-áreas se conserva y no puede pasar de 4 niveles.',
    )}
    <AreaForm
      mode="move"
      initial={valuesOf(area)}
      choices={moveChoices}
      movingName={area.name}
      movingSubAreas={3}
      cancelTo="/plantilla/areas/area-norte-mty"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);

const filled: AreaFormValues = {
  name: 'Base Escobedo',
  code: 'ESC',
  parentId: 'area-norte-mty',
  responsibleIds: ['admin', 'dispatch'],
};
const failure = (code: string, status: 400 | 404 | 409 | 422 | 500, field?: string) =>
  describeFailure(
    {
      code,
      status,
      message: 'x',
      correlationId: 'c',
      ...(field ? { fieldErrors: [{ field, code, message: 'x' }] } : {}),
    },
    'create',
  );

export const Create = { render: () => create() };
export const CreateWithParent = { render: () => create({ initial: emptyValues('area-norte') }) };
export const CreateValidationErrors = {
  render: () => {
    // Opens submitted: the same errors the form shows after "Crear área" with an empty name and bad values.
    const found: AreaFormValues = {
      name: '',
      code: 'base norte',
      parentId: 'area-apodaca-patio',
      responsibleIds: [],
    };
    return create({
      initial: found,
      serverErrors: {
        name: 'Escribe el nombre del área.',
        code: 'Usa hasta 32 caracteres: letras, números, punto, guion o guion bajo, empezando con letra o número.',
        parentId: 'Esa área no está disponible: superaría los 4 niveles. Elige otra.',
      },
    });
  },
};
export const CreateDuplicates = {
  render: () => {
    const { alert, fields } = failure('duplicate', 409, 'name');
    return create({
      initial: filled,
      alert,
      serverErrors: { ...fields, code: 'Ya existe un área con este código en tu empresa.' },
    });
  },
};
export const CreateInvalidHierarchy = {
  render: () => {
    const { alert, fields } = failure('invalid_hierarchy', 422);
    return create({ initial: filled, alert, serverErrors: fields, onAlertAction: noop });
  },
};
export const CreateInvalidResponsible = {
  render: () => {
    const { alert, fields } = failure('invalid_responsible', 422);
    return create({ initial: filled, alert, serverErrors: fields });
  },
};
export const CreateSaving = { render: () => create({ initial: filled, submitting: true }) };
export const CreateLoading = {
  render: () => (
    <Frame>
      {createHeader}
      <UiState kind="loading" />
    </Frame>
  ),
};
export const Edit = { render: () => edit() };
export const EditSaving = { render: () => edit({ submitting: true }) };
export const EditVersionConflict = {
  render: () => {
    const { alert } = describeFailure(
      { code: 'stale_version', status: 409, message: 'x', correlationId: 'c' },
      'edit',
    );
    return edit({ alert, onAlertAction: noop });
  },
};
export const EditImmutable = {
  render: () => {
    const { alert } = describeFailure(
      { code: 'immutable', status: 409, message: 'x', correlationId: 'c' },
      'edit',
    );
    return edit({ alert });
  },
};
export const EditNotEditable = {
  render: () => (
    <Frame>
      {header('Editar área', 'Los cambios se guardan sobre la versión que cargaste.')}
      <AreaNotEditable areaId="area-mty-guadalupe" />
    </Frame>
  ),
};
export const EditNotFound = {
  render: () => (
    <Frame>
      {header('Editar área', 'Los cambios se guardan sobre la versión que cargaste.')}
      <AreaNotFound />
    </Frame>
  ),
};
export const Move = { render: () => move() };
export const MoveWithoutSubAreas = { render: () => move({ movingSubAreas: 0 }) };
export const MoveSaving = { render: () => move({ submitting: true }) };
export const MoveInvalidHierarchy = {
  render: () => {
    const { alert, fields } = describeFailure(
      { code: 'invalid_hierarchy', status: 422, message: 'x', correlationId: 'c' },
      'move',
    );
    return move({ alert, serverErrors: fields, onAlertAction: noop });
  },
};
export const MoveNoChange = {
  render: () => move({ alert: { severity: 'info', message: 'El área ya está en esa ubicación.' } }),
};
export const MoveVersionConflict = {
  render: () => {
    const { alert } = describeFailure(
      { code: 'stale_version', status: 409, message: 'x', correlationId: 'c' },
      'move',
    );
    return move({ alert, onAlertAction: noop });
  },
};
export const NoPermission = {
  render: () => (
    <Frame>
      {createHeader}
      <UiState kind="no-permission" />
    </Frame>
  ),
};
