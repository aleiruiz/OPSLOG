import { withPii } from './mockApiErrors';
import type { Guarded } from './mockApiTypes';
import type { MockAlertsStore } from './mockAlerts';
import type { MockAreaStore } from './mockAreas';
import type { MockDocumentStore } from './mockDocuments';
import type { MockEmployeeStore } from './mockEmployees';
import type { MockInsuranceStore } from './mockInsurance';
import type { MockVehicleStore } from './mockVehicles';
import type { ApiPorts } from './types';

/** Guarded ports of the per-module stores: each operation checks the session and its permission. */
export function createModulePorts(
  guarded: Guarded,
  fleet: MockVehicleStore,
  orgTree: MockAreaStore,
  paperwork: MockDocumentStore,
  cover: MockInsuranceStore,
  staff: MockEmployeeStore,
  warnings: MockAlertsStore,
): Pick<ApiPorts, 'vehicles' | 'areas' | 'documents' | 'insurance' | 'employees' | 'alerts'> {
  return {
    alerts: {
      list: (query) => guarded('listAlerts', 'view', () => warnings.port.list(query)),
      settings: () => guarded('getAlertSettings', 'view', () => warnings.port.settings()),
      saveSettings: (input) =>
        guarded('saveAlertSettings', 'manage_config', () => warnings.port.saveSettings(input)),
    },
    vehicles: {
      list: (query) => guarded('listVehicles', 'view', () => fleet.port.list(query)),
      get: (id) => guarded('getVehicle', 'view', () => fleet.port.get(id)),
      create: (input) => guarded('createVehicle', 'create', () => fleet.port.create(input)),
      update: (id, patch) => guarded('updateVehicle', 'edit', () => fleet.port.update(id, patch)),
      recordOdometer: (id, reading) =>
        guarded('recordOdometer', 'edit', () => fleet.port.recordOdometer(id, reading)),
      archive: (id, version) =>
        guarded('archiveVehicle', 'delete', () => fleet.port.archive(id, version)),
    },
    areas: {
      list: (query) => guarded('listAreas', 'view', () => orgTree.port.list(query)),
      get: (id) => guarded('getArea', 'view', () => orgTree.port.get(id)),
      create: (input) => guarded('createArea', 'create', () => orgTree.port.create(input)),
      update: (id, patch) => guarded('updateArea', 'edit', () => orgTree.port.update(id, patch)),
      deactivate: (id, version) =>
        guarded('deactivateArea', 'delete', () => orgTree.port.deactivate(id, version)),
      activate: (id, version) =>
        guarded('activateArea', 'edit', () => orgTree.port.activate(id, version)),
      history: (id, query) => guarded('areaHistory', 'view', () => orgTree.port.history(id, query)),
    },
    documents: {
      list: (query) => guarded('listDocuments', 'view', () => paperwork.port.list(query)),
      get: (id) => guarded('getDocument', 'view', () => paperwork.port.get(id)),
      create: (input) => guarded('createDocument', 'create', () => paperwork.port.create(input)),
      update: (id, patch) =>
        guarded('updateDocument', 'edit', () => paperwork.port.update(id, patch)),
      renew: (id, renewal) =>
        guarded('renewDocument', 'edit', () => paperwork.port.renew(id, renewal)),
      archive: (id, version) =>
        guarded('archiveDocument', 'delete', () => paperwork.port.archive(id, version)),
      history: (id, query) =>
        guarded('documentHistory', 'view', () => paperwork.port.history(id, query)),
    },
    insurance: {
      list: (query) => guarded('listPolicies', 'view', () => cover.port.list(query)),
      get: (id) => guarded('getPolicy', 'view', () => cover.port.get(id)),
      create: (input) => guarded('createPolicy', 'create', () => cover.port.create(input)),
      update: (id, patch) => guarded('updatePolicy', 'edit', () => cover.port.update(id, patch)),
      renew: (id, renewal) => guarded('renewPolicy', 'edit', () => cover.port.renew(id, renewal)),
      archive: (id, version) =>
        guarded('archivePolicy', 'delete', () => cover.port.archive(id, version)),
      history: (id, query) => guarded('policyHistory', 'view', () => cover.port.history(id, query)),
    },
    employees: {
      list: (query) => guarded('listEmployees', 'view', () => staff.port.list(query)),
      get: (id) => guarded('getEmployee', 'view', () => staff.port.get(id)),
      create: (input) =>
        guarded('createEmployee', withPii('create', input), () => staff.port.create(input)),
      update: (id, patch) =>
        guarded('updateEmployee', withPii('edit', patch), () => staff.port.update(id, patch)),
      changeStatus: (id, change) =>
        guarded('changeEmployeeStatus', 'edit', () => staff.port.changeStatus(id, change)),
      archive: (id, version) =>
        guarded('archiveEmployee', 'delete', () => staff.port.archive(id, version)),
      history: (id, query) =>
        guarded('employeeHistory', 'view', () => staff.port.history(id, query)),
    },
  };
}
