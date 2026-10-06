import type { Area, EmployeeDetail, EmployeesPort, Result } from '../app/types';
import type { AreasPort } from '../app/types';
import { loadAllAreas } from '../areas/loadAreas';

export interface EmployeeContext {
  readonly employee: EmployeeDetail;
  /** The company's areas (every status) to name the employee's area and the areas in its history. */
  readonly areas: readonly Area[];
}

/**
 * One employee with the structure that names its area. The employee is the screen's data: a structure that
 * cannot be loaded (any failure but an expired session) leaves the names out instead of hiding the employee, and
 * the screen falls back to the ids.
 */
export async function loadEmployeeContext(
  employees: EmployeesPort,
  areas: AreasPort,
  id: string,
): Promise<Result<EmployeeContext>> {
  const [detail, catalog] = await Promise.all([employees.get(id), loadAllAreas(areas, true)]);
  if (!detail.ok) return detail;
  if (!catalog.ok && catalog.error.status === 401) return catalog;
  return {
    ok: true,
    value: { employee: detail.value, areas: catalog.ok ? catalog.value.areas : [] },
  };
}
