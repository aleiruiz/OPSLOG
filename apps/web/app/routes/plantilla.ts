import type { RouteDefinition } from './types';

/** Nav group "Plantilla": employees and areas. */
export const plantillaRoutes: readonly RouteDefinition[] = [
  // Employees (FLT-PEOPLE, nav group "Plantilla"): read = `view`, create = `create`, change = `edit`; archiving
  // (`delete`) and the status change are actions of the detail. Personal data needs `view_pii` inside the screens.
  {
    id: 'employees',
    pattern: '/plantilla/empleados',
    title: 'Empleados',
    access: { permission: 'view' },
    nav: { group: 'Plantilla', label: 'Empleados' },
  },
  {
    id: 'employeeNew',
    pattern: '/plantilla/empleados/nuevo',
    title: 'Nuevo empleado',
    access: { permission: 'create' },
  },
  {
    id: 'employeeDetail',
    pattern: '/plantilla/empleados/:id',
    title: 'Empleado',
    access: { permission: 'view' },
  },
  {
    id: 'employeeEdit',
    pattern: '/plantilla/empleados/:id/editar',
    title: 'Editar empleado',
    access: { permission: 'edit' },
  },
  // Areas (BRD S06, nav group "Plantilla"): read = `view`, create = `create`, edit/move/activate = `edit`; deactivating
  // (`delete`) is an action of the detail.
  {
    id: 'areas',
    pattern: '/plantilla/areas',
    title: 'Áreas',
    access: { permission: 'view' },
    nav: { group: 'Plantilla', label: 'Áreas' },
  },
  {
    id: 'areaNew',
    pattern: '/plantilla/areas/nueva',
    title: 'Nueva área',
    access: { permission: 'create' },
  },
  {
    id: 'areaDetail',
    pattern: '/plantilla/areas/:id',
    title: 'Área',
    access: { permission: 'view' },
  },
  {
    id: 'areaEdit',
    pattern: '/plantilla/areas/:id/editar',
    title: 'Editar área',
    access: { permission: 'edit' },
  },
  {
    id: 'areaMove',
    pattern: '/plantilla/areas/:id/mover',
    title: 'Mover área',
    access: { permission: 'edit' },
  },
];
