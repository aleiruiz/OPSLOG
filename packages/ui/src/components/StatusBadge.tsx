import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { statusColors, StatusTone } from '../tokens';
export type StatusBadgeProps = {
  label: string;
  tone: StatusTone;
  description?: string;
  severity?: string;
};
export function StatusBadge({ label, tone, description, severity }: StatusBadgeProps) {
  const colors = statusColors[tone];
  const accessibleLabel = [
    `Estado: ${label}`,
    severity && `Severidad: ${severity}`,
    description && `Descripción: ${description}`,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <Stack direction="row" alignItems="center" spacing={1} aria-label={accessibleLabel}>
      <Chip
        label={label}
        sx={{ color: colors.foreground, bgcolor: colors.background, fontWeight: 600 }}
      />
      {severity && (
        <Typography component="span" variant="body2" color="text.secondary">
          {severity}
        </Typography>
      )}
      {description && (
        <Typography component="span" variant="body2" color="text.secondary">
          {description}
        </Typography>
      )}
    </Stack>
  );
}
