import { EntityAuditTab } from '../audit';
import { FollowButton } from '../notifications';
import { ReportLinks } from '../reports';
import type { IncidentExtras } from './context';

/** What the shell mounts in a case: «Seguir», the link to its PDF sheet and the audit history tab. */
export const incidentExtras: IncidentExtras = {
  actions: (incident) => (
    <>
      <FollowButton type="incident" entityId={incident.id} />
      <ReportLinks
        links={[
          { label: 'Ficha PDF', reportId: 'incident_sheet', filters: { folio: incident.folio } },
        ]}
      />
    </>
  ),
  history: (incidentId) => <EntityAuditTab entityType="incident" entityId={incidentId} />,
};
