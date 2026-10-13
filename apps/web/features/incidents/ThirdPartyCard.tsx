import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, DescriptionList } from '@opslog/ui';
import type { BffThirdParty } from '@opslog/contracts';
import { KIND_LABELS, YES_NO } from './labels';

/**
 * One third party. Without `view_pii` the server sends no identity at all, so there is nothing to hide
 * here: the card says the data is restricted instead of drawing empty fields or asterisks.
 */
export function ThirdPartyCard({
  party,
  position,
  writable,
  onEdit,
  onRemove,
}: {
  party: BffThirdParty;
  position: number;
  writable: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const title = `${KIND_LABELS[party.kind]} ${position}`;
  const identity = party.identityRestricted
    ? []
    : [
        { label: 'Nombre', value: party.name ?? 'Sin dato' },
        { label: 'Contacto', value: party.contact ?? 'Sin dato' },
        { label: 'Placas', value: party.plates ?? 'Sin dato' },
        { label: 'Póliza', value: party.policyNumber ?? 'Sin dato' },
      ];
  return (
    <Box
      component="li"
      aria-label={title}
      sx={{ listStyle: 'none', border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}
    >
      <Typography component="h3" variant="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {party.identityRestricted && (
        <Typography color="text.secondary" sx={{ mb: 1.5 }}>
          Datos de identidad restringidos
        </Typography>
      )}
      <DescriptionList
        columns={2}
        items={[
          ...identity,
          { label: 'Aseguradora', value: party.insurerName ?? 'Sin dato' },
          { label: 'Daños', value: party.damageDescription ?? 'Sin descripción' },
          { label: 'Lesiones', value: party.injuries ? YES_NO.yes : YES_NO.no },
        ]}
      />
      {writable && (
        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={onEdit}>
            {`Editar ${title}`}
          </Button>
          <Button variant="text" color="error" onClick={onRemove}>
            {`Retirar ${title}`}
          </Button>
        </Box>
      )}
    </Box>
  );
}
