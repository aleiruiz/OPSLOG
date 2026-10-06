import React from 'react';
import { NextStepPanel, PageHeader } from '@opslog/ui';
import type { Permission, SessionInfo } from './types';

/** Landing screen: what the person can do next, derived from their permissions only. */
export function HomeScreen({
  session,
  can,
}: {
  session: SessionInfo;
  can: (permission: Permission) => boolean;
}) {
  const steps: string[] = [];
  if (can('manage_config')) steps.push('Revisa los datos y la política de acceso de la empresa.');
  if (can('manage_users')) steps.push('Invita a tu equipo y revisa sus roles.');
  if (steps.length === 0)
    steps.push('Tu rol permite consultar información. Pronto verás aquí tus módulos.');
  return (
    <>
      <PageHeader
        title="Inicio"
        description={`Esta es la cuenta de ${session.company.name} con el rol ${session.roleLabel}.`}
      />
      <NextStepPanel title="Siguiente paso" steps={steps} />
    </>
  );
}
