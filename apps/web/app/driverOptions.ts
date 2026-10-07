import type { EmployeesPort, EmployeeStatus, Result } from './types';

export interface DriverOption {
  readonly id: string;
  /** What the person picks by: the full name and the employee number. The list holds no personal data (no `view_pii`). */
  readonly label: string;
  /** Plain name, to show a driver whose assignment is read-only. */
  readonly name: string;
  readonly status: EmployeeStatus;
}

export interface DriverOptions {
  readonly items: readonly DriverOption[];
  /** More drivers exist than were loaded (the selector holds the first `MAX_DRIVER_OPTIONS`). */
  readonly truncated: boolean;
}

const PAGE = 100;
const MAX_PAGES = 5;
export const MAX_DRIVER_OPTIONS = PAGE * MAX_PAGES;

/**
 * The drivers of the company (every status, archived ones hidden by the listing), for a selector or to name the driver
 * of an assignment. Assignments only accept active drivers: `isEligibleDriver` filters what the form offers.
 */
export async function loadDriverOptions(employees: EmployeesPort): Promise<Result<DriverOptions>> {
  const items: DriverOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await employees.list({
      kind: 'driver',
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.ok) return result;
    for (const employee of result.value.items) {
      const name = `${employee.firstName} ${employee.lastName}`;
      items.push({
        id: employee.id,
        name,
        status: employee.status,
        label: employee.employeeNumber ? `${name} · ${employee.employeeNumber}` : name,
      });
    }
    if (result.value.nextCursor === null) return { ok: true, value: { items, truncated: false } };
    cursor = result.value.nextCursor;
  }
  return { ok: true, value: { items, truncated: true } };
}

/** BR-014: only an active driver can be assigned. */
export const isEligibleDriver = (option: Pick<DriverOption, 'status'>): boolean =>
  option.status === 'active';
