import type { Permission } from '../types';

export type RouteAccess =
  | 'public'
  | 'authenticated'
  | { readonly permission: Permission }
  /** Any one of these grants access (incidents: creating or reporting). */
  | { readonly anyOf: readonly Permission[] };

export type NavGroup =
  | 'Inicio'
  | 'Plantilla'
  | 'Flota'
  | 'Operación'
  | 'Análisis'
  | 'Configuración';

export interface RouteDefinition {
  readonly id:
    | 'home'
    | 'login'
    | 'invitation'
    | 'authCallback'
    | 'company'
    | 'users'
    | 'roles'
    | 'vehicles'
    | 'vehicleNew'
    | 'vehicleDetail'
    | 'vehicleEdit'
    | 'assignments'
    | 'assignmentNew'
    | 'assignmentDetail'
    | 'assignmentEnd'
    | 'imports'
    | 'importNew'
    | 'importDetail'
    | 'areas'
    | 'areaNew'
    | 'areaDetail'
    | 'areaEdit'
    | 'areaMove'
    | 'documents'
    | 'documentNew'
    | 'documentDetail'
    | 'documentEdit'
    | 'documentRenew'
    | 'policies'
    | 'policyNew'
    | 'policyDetail'
    | 'policyEdit'
    | 'policyRenew'
    | 'employees'
    | 'employeeNew'
    | 'employeeDetail'
    | 'employeeEdit'
    | 'alerts'
    | 'alertSettings'
    | 'maintenance'
    | 'maintenanceOrder'
    | 'incidents'
    | 'incidentNew'
    | 'incidentAlerts'
    | 'incidentSettings'
    | 'incidentDetail'
    | 'incidentTab'
    | 'audit'
    | 'search'
    | 'reports'
    | 'notifications'
    | 'notificationPreferences';
  readonly pattern: string;
  readonly title: string;
  readonly access: RouteAccess;
  /** `requires`: an extra permission for the navigation entry only (the route itself follows `access`). */
  readonly nav?: {
    readonly group: NavGroup;
    readonly label: string;
    readonly requires?: Permission;
  };
}
