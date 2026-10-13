import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import { Button, Field, FormSection } from '@opslog/ui';
import type { BffMaintenanceWorkshop } from '@opslog/contracts';
import type { MemberOption } from './CatalogScreen';

const split = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
export function WorkshopForm({
  onSubmit,
}: {
  onSubmit: (body: {
    name: string;
    specialties: string[];
    contact: string | null;
  }) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [specialties, setSpecialties] = React.useState('');
  const [contact, setContact] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (
      await onSubmit({
        name: name.trim(),
        specialties: split(specialties),
        contact: contact.trim() || null,
      })
    ) {
      setName('');
      setSpecialties('');
      setContact('');
    }
  };
  return (
    <Box component="form" noValidate aria-label="Nuevo taller" onSubmit={submit}>
      <FormSection title="Nuevo taller">
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-ws-name"
            sx={{ flex: 1 }}
            label="Nombre del taller"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="mnt-ws-specialties"
            sx={{ flex: 1 }}
            label="Especialidades del taller (separadas por coma)"
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
          />
          <Field
            id="mnt-ws-contact"
            sx={{ flex: 1 }}
            label="Contacto"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </Stack>
        <Box>
          <Button type="submit" variant="contained">
            Agregar taller
          </Button>
        </Box>
      </FormSection>
    </Box>
  );
}

export function MechanicForm({
  workshops,
  members,
  onSubmit,
}: {
  workshops: readonly BffMaintenanceWorkshop[];
  members: readonly MemberOption[];
  onSubmit: (body: {
    name: string;
    specialties: string[];
    kind: 'internal' | 'external';
    workshopId: string | null;
    memberId: string | null;
  }) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [specialties, setSpecialties] = React.useState('');
  const [kind, setKind] = React.useState<'internal' | 'external'>('external');
  const [workshopId, setWorkshopId] = React.useState('');
  const [memberId, setMemberId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || (kind === 'internal' && !memberId)) {
      setError(
        kind === 'internal'
          ? 'Elige el usuario de la empresa que es este mecánico.'
          : 'Escribe el nombre.',
      );
      return;
    }
    setError(null);
    const saved = await onSubmit({
      name: name.trim(),
      specialties: split(specialties),
      kind,
      workshopId: workshopId || null,
      memberId: kind === 'internal' ? memberId : null,
    });
    if (saved) {
      setName('');
      setSpecialties('');
      setMemberId('');
    }
  };
  return (
    <Box component="form" noValidate aria-label="Nuevo mecánico" onSubmit={submit}>
      <FormSection
        title="Nuevo mecánico"
        description="Un mecánico externo no tiene cuenta: registra su trabajo quien inicia sesión."
      >
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-mec-name"
            sx={{ flex: 1 }}
            label="Nombre del mecánico"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="mnt-mec-specialties"
            sx={{ flex: 1 }}
            label="Especialidades del mecánico (separadas por coma)"
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
          />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            select
            id="mnt-mec-kind"
            label="Vínculo"
            sx={{ flex: 1 }}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'internal' | 'external')}
          >
            <MenuItem value="external">Externo (sin cuenta)</MenuItem>
            <MenuItem value="internal" disabled={members.length === 0}>
              Interno (usuario de la empresa)
            </MenuItem>
          </Field>
          {kind === 'internal' && (
            <Field
              select
              id="mnt-mec-member"
              label="Usuario de la empresa"
              sx={{ flex: 1 }}
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
            >
              {members.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.label}
                </MenuItem>
              ))}
            </Field>
          )}
          <Field
            select
            id="mnt-mec-workshop"
            label="Taller"
            sx={{ flex: 1 }}
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
            value={workshopId}
            onChange={(e) => setWorkshopId(e.target.value)}
          >
            <MenuItem value="">Sin taller</MenuItem>
            {workshops.map((w) => (
              <MenuItem key={w.id} value={w.id}>
                {w.name}
              </MenuItem>
            ))}
          </Field>
        </Stack>
        <Box>
          <Button type="submit" variant="contained">
            Agregar mecánico
          </Button>
        </Box>
      </FormSection>
    </Box>
  );
}
