export {
  VEHICLE_STATUSES,
  type VehicleStatus,
  STATUS_TRANSITIONS,
  isVehicleStatus,
  MAX_ODOMETER_KM,
  MIN_MODEL_YEAR,
  MAX_REASON_LENGTH,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  type Vehicle,
  type VehicleStatusEntry,
  type VehicleCore,
  type NewVehicleData,
} from './types.js';
export {
  canTransition,
  newVehicle,
  statusEntry,
  applyPatch,
  applyStatus,
  applyOdometer,
  applyArchive,
  isLiveVehicle,
} from './rules.js';
export { type VehicleErrorCode, type VehicleConflictField, VehicleError } from './errors.js';
export {
  requireOpaqueId,
  normalizeEconomicNumber,
  economicNumberKey,
  normalizePlate,
  plateKey,
  normalizeVin,
  dateOf,
  normalizeReason,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  parseNewVehicle,
  parseVehiclePatch,
  requireVersion,
} from './validation.js';
export {
  type VehicleFilter,
  type VehicleWindow,
  type VehicleSlice,
  type VehicleStore,
  type VehicleAreaGate,
} from './ports.js';
export { InMemoryVehicleStore } from './store.js';
export { type VehicleListQuery, type VehicleServiceOptions, VehicleService } from './service.js';
