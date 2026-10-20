import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BffReportCatalog } from '@opslog/contracts';
import { Button, Panel, UiState } from '@opslog/ui';
import { copy } from './labels';

/** The reports the reader may see, grouped by family. */
export function CatalogTab({
  catalog,
  onOpen,
}: {
  readonly catalog: BffReportCatalog;
  readonly onOpen: (reportId: string) => void;
}) {
  if (catalog.reports.length === 0)
    return (
      <UiState
        kind="empty"
        title="Sin reportes disponibles"
        description="Tu rol no incluye reportes. Pide acceso a la administración de tu empresa."
      />
    );
  return (
    <>
      {catalog.families.map((family) => {
        const reports = catalog.reports.filter((report) => report.family === family.id);
        if (reports.length === 0) return null;
        const heading = `reportes-${family.id}`;
        return (
          <Box component="section" key={family.id} aria-labelledby={heading} sx={{ mb: 3 }}>
            <Typography variant="h2" component="h2" id={heading} sx={{ mb: 1.5 }}>
              {family.label}
            </Typography>
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                p: 0,
                m: 0,
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
              }}
            >
              {reports.map((report) => (
                <li key={report.id}>
                  <Panel title={report.title} description={report.description} headingLevel={3}>
                    <Button
                      variant="outlined"
                      aria-label={`${copy.open}: ${report.title}`}
                      onClick={() => onOpen(report.id)}
                    >
                      {copy.open}
                    </Button>
                  </Panel>
                </li>
              ))}
            </Box>
          </Box>
        );
      })}
    </>
  );
}
