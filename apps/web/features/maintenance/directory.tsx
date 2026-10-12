import React from 'react';
import { Field } from '@opslog/ui';
import type { BffMaintenanceMechanic } from '@opslog/contracts';

/** A person-readable choice: the id is what the API takes, the label is all the screen shows. */
export interface DirectoryOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Human labels for the ids the maintenance screens hold. Vehicles come from the vehicles list and
 * members from the user directory plus the mechanics linked to them; the identity contract carries
 * no names or emails by design, so a member is named by their linked mechanic or by role.
 */
export interface MaintenanceDirectory {
  /** `null` when the vehicles could not be loaded. */
  readonly vehicles: readonly DirectoryOption[] | null;
  readonly vehiclesTruncated: boolean;
  readonly members: readonly DirectoryOption[];
  readonly membersTruncated: boolean;
  readonly reloadVehicles?: () => void;
}

export const emptyDirectory: MaintenanceDirectory = {
  vehicles: null,
  vehiclesTruncated: false,
  members: [],
  membersTruncated: false,
};

const DirectoryContext = React.createContext<MaintenanceDirectory>(emptyDirectory);
export const DirectoryProvider = DirectoryContext.Provider;
export const useDirectory = (): MaintenanceDirectory => React.useContext(DirectoryContext);

export const UNKNOWN_VEHICLE = 'Vehículo no disponible';
export const UNKNOWN_MEMBER = 'Otra persona de la empresa';

export const vehicleLabel = (directory: MaintenanceDirectory, id: string): string =>
  directory.vehicles?.find((option) => option.id === id)?.label ?? UNKNOWN_VEHICLE;
export const memberLabel = (directory: MaintenanceDirectory, id: string): string =>
  directory.members.find((option) => option.id === id)?.label ?? UNKNOWN_MEMBER;

/**
 * Members offered as responsible: the caller first, then everyone else by label. A member linked to
 * an active internal mechanic is named after the mechanic; otherwise by the role label given.
 */
export function memberOptions(
  listed: readonly DirectoryOption[],
  mechanics: readonly BffMaintenanceMechanic[],
  userId: string,
): readonly DirectoryOption[] {
  const labels = new Map(listed.map((option) => [option.id, option.label]));
  for (const mechanic of mechanics)
    if (mechanic.active && mechanic.memberId !== null)
      labels.set(
        mechanic.memberId,
        labels.has(mechanic.memberId)
          ? `${mechanic.name} · ${labels.get(mechanic.memberId)}`
          : `${mechanic.name} (mecánico interno)`,
      );
  const own = labels.get(userId);
  labels.set(userId, own === undefined ? 'Tú' : `${own} (tú)`);
  return [...labels.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) =>
      a.id === userId ? -1 : b.id === userId ? 1 : a.label.localeCompare(b.label, 'es'),
    );
}

/** A native select: labelled, keyboard and screen-reader friendly, and it works with hundreds of options. */
export function OptionPicker({
  id,
  label,
  value,
  options,
  placeholder,
  required = false,
  description,
  currentLabel = 'Valor actual (fuera de la lista)',
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly DirectoryOption[];
  placeholder: string;
  required?: boolean;
  description?: string;
  /** Names a saved value that is not among `options`. */
  currentLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={id}
      label={label}
      select
      required={required}
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...(description === undefined ? {} : { description })}
    >
      <option value="">{placeholder}</option>
      {value !== '' && !options.some((option) => option.id === value) ? (
        // The saved value is outside the loaded list (no directory access, or a deactivated
        // member): name it instead of letting the select announce the placeholder.
        <option value={value}>{currentLabel}</option>
      ) : null}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </Field>
  );
}
