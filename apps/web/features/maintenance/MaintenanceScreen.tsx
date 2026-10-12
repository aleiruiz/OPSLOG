import React from 'react';
import { useSession } from '../../auth/session';
import type { MemberOption } from './CatalogScreen';
import { MaintenanceArea } from './MaintenanceArea';

/**
 * Shell entry for maintenance: the session's ports, grants and user, with the shared 401 handling.
 * Company members for linking internal mechanics come from the user directory when the session may
 * read it (`manage_users`); otherwise only external mechanics can be registered here.
 */
export function MaintenanceScreen() {
  const { state, ports, can, markExpired } = useSession();
  const [members, setMembers] = React.useState<readonly MemberOption[]>([]);
  const mayListMembers = can('manage_users');
  React.useEffect(() => {
    if (!mayListMembers) return;
    let current = true;
    void ports.users.listUsers({ limit: 100 }).then((result) => {
      if (!current || !result.ok) return;
      setMembers(
        result.value.items
          .filter((user) => user.status === 'active')
          .map((user) => ({ id: user.id, label: `${user.roleLabel} · ${user.id}` })),
      );
    });
    return () => {
      current = false;
    };
  }, [ports, mayListMembers]);
  if (state.status !== 'authenticated' && state.status !== 'expired') return null;
  return (
    <MaintenanceArea
      ports={ports.maintenance}
      permissions={state.session.permissions}
      userId={state.session.user.id}
      members={members}
      onExpired={markExpired}
    />
  );
}
