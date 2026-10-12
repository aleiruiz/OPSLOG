import type {
  ApiError,
  BffClient,
  BffMaintenanceAlert,
  BffMaintenanceAlertsQuery,
  BffMaintenanceMechanic,
  BffMaintenanceMechanicInput,
  BffMaintenancePlan,
  BffMaintenancePlanInput,
  BffMaintenancePlanPatch,
  BffMaintenancePlanSchedule,
  BffMaintenanceWorkshop,
  BffMaintenanceWorkshopInput,
  BffAlertSettings,
  BffAlertSettingsInput,
  BffWorkOrder,
  BffWorkOrderCostsInput,
  BffWorkOrderFile,
  BffWorkOrderFileContent,
  BffWorkOrderFileUpload,
  BffWorkOrderTransition,
  BffWorkOrderTransitionInput,
  BffWorkOrderWorkInput,
  Page,
} from '@opslog/contracts';

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/**
 * What the maintenance screens need from the BFF, one method per accepted contract route
 * (MNT-PLANS and MNT-ORDERS). Authorization stays on the server; these ports only carry requests.
 */
export interface MaintenancePorts {
  readonly orders: {
    list(): Promise<Result<readonly BffWorkOrder[]>>;
    get(id: string): Promise<Result<BffWorkOrder>>;
    history(id: string): Promise<Result<readonly BffWorkOrderTransition[]>>;
    createCorrective(body: {
      vehicleId: string;
      description: string;
    }): Promise<Result<BffWorkOrder>>;
    adoptPreventive(body: {
      planId: string;
      scheduledOrderId: string;
    }): Promise<Result<BffWorkOrder>>;
    /** `idempotencyKey` travels as the Idempotency-Key header (required to close and reopen). */
    transition(
      id: string,
      body: BffWorkOrderTransitionInput,
      idempotencyKey: string,
    ): Promise<Result<BffWorkOrder>>;
    recordWork(id: string, body: BffWorkOrderWorkInput): Promise<Result<BffWorkOrder>>;
    recordCosts(id: string, body: BffWorkOrderCostsInput): Promise<Result<BffWorkOrder>>;
    /** Evidence and invoices of the order (G3 H3); the server decides what each caller sees. */
    files: {
      list(id: string): Promise<Result<readonly BffWorkOrderFile[]>>;
      upload(id: string, body: BffWorkOrderFileUpload): Promise<Result<BffWorkOrder>>;
      detach(id: string, fileId: string, version: number): Promise<Result<BffWorkOrder>>;
      content(id: string, fileId: string): Promise<Result<BffWorkOrderFileContent>>;
    };
  };
  /** Company settings that drive maintenance (evidence requirement, D20 threshold, time zone). */
  readonly settings: {
    get(): Promise<Result<BffAlertSettings>>;
    save(body: BffAlertSettingsInput): Promise<Result<BffAlertSettings>>;
  };
  readonly plans: {
    list(): Promise<Result<readonly BffMaintenancePlan[]>>;
    create(body: BffMaintenancePlanInput): Promise<Result<BffMaintenancePlan>>;
    update(id: string, body: BffMaintenancePlanPatch): Promise<Result<BffMaintenancePlan>>;
    schedule(id: string): Promise<Result<BffMaintenancePlanSchedule>>;
  };
  /** In-app records the plans worker persisted (upcoming, due, overdue), newest first. */
  readonly alerts: {
    list(query?: BffMaintenanceAlertsQuery): Promise<Result<Page<BffMaintenanceAlert>>>;
  };
  readonly workshops: {
    list(): Promise<Result<readonly BffMaintenanceWorkshop[]>>;
    create(body: BffMaintenanceWorkshopInput): Promise<Result<BffMaintenanceWorkshop>>;
    deactivate(id: string): Promise<Result<BffMaintenanceWorkshop>>;
  };
  readonly mechanics: {
    list(): Promise<Result<readonly BffMaintenanceMechanic[]>>;
    create(body: BffMaintenanceMechanicInput): Promise<Result<BffMaintenanceMechanic>>;
    deactivate(id: string): Promise<Result<BffMaintenanceMechanic>>;
  };
}

/** The ports over the typed BFF client; method, path and CSRF come from the contract module. */
export function createMaintenancePorts(client: BffClient): MaintenancePorts {
  const { call } = client;
  return {
    orders: {
      list: () => call('workOrders.list'),
      get: (orderId) => call('workOrders.get', { params: { orderId } }),
      history: (orderId) => call('workOrders.history', { params: { orderId } }),
      createCorrective: (body) => call('workOrders.create', { body }),
      adoptPreventive: (body) => call('workOrders.adopt', { body }),
      transition: (orderId, body, idempotencyKey) =>
        call('workOrders.transition', { params: { orderId }, body, idempotencyKey }),
      recordWork: (orderId, body) => call('workOrders.work', { params: { orderId }, body }),
      recordCosts: (orderId, body) => call('workOrders.costs', { params: { orderId }, body }),
      files: {
        list: (orderId) => call('workOrders.files.list', { params: { orderId } }),
        upload: (orderId, body) => call('workOrders.files.upload', { params: { orderId }, body }),
        detach: (orderId, fileId, version) =>
          call('workOrders.files.detach', { params: { orderId, fileId }, body: { version } }),
        content: (orderId, fileId) =>
          call('workOrders.files.content', { params: { orderId, fileId } }),
      },
    },
    settings: {
      get: () => call('alerts.settings.get'),
      save: (body) => call('alerts.settings.update', { body }),
    },
    plans: {
      list: () => call('maintenance.plans.list'),
      create: (body) => call('maintenance.plans.create', { body }),
      update: (planId, body) => call('maintenance.plans.update', { params: { planId }, body }),
      schedule: (planId) => call('maintenance.plans.schedule', { params: { planId } }),
    },
    alerts: {
      list: (query) =>
        query ? call('maintenance.alerts.list', { query }) : call('maintenance.alerts.list'),
    },
    workshops: {
      list: () => call('maintenance.workshops.list'),
      create: (body) => call('maintenance.workshops.create', { body }),
      deactivate: (workshopId) =>
        call('maintenance.workshops.deactivate', { params: { workshopId } }),
    },
    mechanics: {
      list: () => call('maintenance.mechanics.list'),
      create: (body) => call('maintenance.mechanics.create', { body }),
      deactivate: (mechanicId) =>
        call('maintenance.mechanics.deactivate', { params: { mechanicId } }),
    },
  };
}
