import type { ApiError } from '@opslog/contracts';
import type { MockAreaStore } from './mockAreas';
import type { MockDocumentStore } from './mockDocuments';
import type { MockEmployeeStore } from './mockEmployees';
import type { MockInsuranceStore } from './mockInsurance';
import type { MockVehicleStore } from './mockVehicles';
import type { MockControls, MockOperation } from './mockApiTypes';
import type { DraftRecord, UserSummary } from './types';

/** Test controls over the mock's server-side state; `session` exposes the private signed-in user. */
export function createControls(
  session: { current(): string | null; clear(): void },
  failures: Map<MockOperation, ApiError['status']>,
  users: UserSummary[],
  drafts: Map<string, DraftRecord>,
  fleet: MockVehicleStore,
  orgTree: MockAreaStore,
  paperwork: MockDocumentStore,
  cover: MockInsuranceStore,
  staff: MockEmployeeStore,
): MockControls {
  return {
    expireSession: () => {
      session.clear();
    },
    failNext: (operation, status = 500) => {
      failures.set(operation, status);
    },
    isSignedIn: () => session.current() !== null,
    setUserStatus: (userId, status) => {
      const index = users.findIndex((user) => user.id === userId);
      const target = users[index];
      if (target) users[index] = { ...target, status };
    },
    storedDrafts: () =>
      Object.fromEntries(
        [...drafts.entries()]
          .filter(([key]) => key.startsWith(`${session.current() ?? ''}:`))
          .map(([key, record]) => [key.slice(key.indexOf(':') + 1), record.values]),
      ),
    changeVehicleExternally: (id, change) => fleet.changeExternally(id, change),
    archiveVehicleExternally: (id) => fleet.archiveExternally(id),
    vehicles: () => fleet.snapshot(),
    changeAreaExternally: (id, change) => orgTree.changeExternally(id, change),
    deactivateAreaExternally: (id) => orgTree.deactivateExternally(id),
    setAreaPeople: (id, people) => orgTree.setPeople(id, people),
    areas: () => orgTree.snapshot(),
    changeDocumentExternally: (id, change) => paperwork.changeExternally(id, change),
    archiveDocumentExternally: (id) => paperwork.archiveExternally(id),
    documents: () => paperwork.snapshot(),
    changePolicyExternally: (id, change) => cover.changeExternally(id, change),
    archivePolicyExternally: (id) => cover.archiveExternally(id),
    policies: () => cover.snapshot(),
    changeEmployeeExternally: (id, change) => staff.changeExternally(id, change),
    archiveEmployeeExternally: (id) => staff.archiveExternally(id),
    terminateEmployeeExternally: (id) => staff.terminateExternally(id),
    employees: () => staff.snapshot(),
    employeeAudit: () => staff.auditLog(),
  };
}
