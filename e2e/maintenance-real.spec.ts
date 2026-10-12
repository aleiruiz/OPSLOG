import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });
import { AUDIT_TABLES } from '../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../packages/persistence/maintenance/plans/src/index.js';
import {
  deliverOutboxEvents,
  enqueuePlanScans,
  makeEventsAvailable,
} from '../tests/fixtures/maintenance/plan-scan.js';
import { startRealStack, type RealTenant } from './real-api/harness.js';

// MNT-INTEGRATE / MNT-QA browser journey: the real web shell against the composed BFF over a
// disposable synthetic MySQL 8.4 database (one physical database per tenant). No mocks.
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const shown = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// One long journey over a real stack: generous per-test and per-assertion budgets under CI load.
test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use({ actionTimeout: 15_000 });
test.skip(!adminUrl && !process.env.CI, 'needs OPSLOG_TEST_MYSQL_ADMIN_URL (synthetic MySQL 8.4)');

let stack: Awaited<ReturnType<typeof startRealStack>>;
let a: RealTenant;
let b: RealTenant;
let vehicleId: string;
let orderId: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!adminUrl)
    throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; the journey must not skip');
  stack = await startRealStack();
  ({ a, b } = stack);
  vehicleId = await a.vehicle('E2E01');
  await a.member('editor', 'e2e-editor-a');
});
test.afterAll(async () => {
  await stack?.close();
});

async function signIn(page: Page, tenant: RealTenant, account: string) {
  await page.goto(`${tenant.webUrl}/real/flota/mantenimiento`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).fill(account);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Órdenes de mantenimiento' })).toBeVisible();
}
const submit = (page: Page, form: string, button = form) =>
  page.getByRole('form', { name: form }).getByRole('button', { name: button }).click();
async function pick(page: Page, label: string, option: string) {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('preventive order from plan to closure advances the plan once, over the real API', async ({
  page,
}) => {
  await signIn(page, a, 'e2e-admin-a');
  const me = (await page.evaluate(async () => (await fetch('/api/auth/session')).json())) as {
    user: { id: string };
  };

  await page.getByRole('tab', { name: 'Talleres y mecánicos' }).click();
  await page.getByLabel(/Nombre del taller/).fill('Taller E2E');
  await page.getByRole('button', { name: 'Agregar taller' }).click();
  await expect(page.getByRole('table', { name: '1 talleres' })).toBeVisible();

  await page.getByRole('tab', { name: 'Planes' }).click();
  await page.getByRole('button', { name: 'Nuevo plan' }).click();
  await page.getByLabel(/^Vehículo/).fill(vehicleId);
  await page.getByLabel('Cada cuántos días').fill('30');
  await page.getByLabel('Fecha del último servicio').fill(day(-31));
  await submit(page, 'Nuevo plan', 'Guardar plan');
  await expect(page.getByRole('table', { name: '1 planes' })).toBeVisible();
  await expectNoViolations(page);

  const [plan] = await a.database.rows<{ id: string }>(
    `SELECT id FROM ${MAINTENANCE_TABLES.plans} WHERE company_id = ? AND vehicle_id = ?`,
    [a.tenantId, vehicleId],
  );
  const scans = await enqueuePlanScans(a.database, a.tenantId, [
    { planId: plan?.id as string, attempt: 'browser' },
  ]);
  await deliverOutboxEvents(a.platform, a.database, a.tenantId, scans);

  await page.getByRole('tab', { name: 'Órdenes', exact: true }).click();
  await page.getByRole('tab', { name: 'Planes' }).click();
  await page.getByRole('button', { name: vehicleId }).click();
  await expect(page.getByText(/Orden generada por fecha/)).toBeVisible();
  await page.getByRole('button', { name: 'Abrir orden de trabajo' }).click();
  await expect(page.getByLabel('Estado: Programada')).toBeVisible();
  orderId = (
    await a.database.rows<{ id: string }>(
      `SELECT id FROM ${MAINTENANCE_TABLES.orders} WHERE company_id = ? AND plan_id = ?`,
      [a.tenantId, plan?.id],
    )
  )[0]?.id as string;

  await page.getByRole('button', { name: 'Asignar' }).click();
  await page.getByLabel('Persona responsable (usuario)').fill(me.user.id);
  await pick(page, 'Taller', 'Taller E2E');
  await page.getByLabel('Fecha programada').fill(day(0));
  await submit(page, 'Asignar');
  await expect(page.getByLabel('Estado: Asignada')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar trabajo' }).click();
  await submit(page, 'Iniciar trabajo');
  await expect(page.getByLabel('Estado: En proceso')).toBeVisible();
  await page.getByRole('button', { name: 'Registrar trabajo' }).click();
  await page.getByLabel('Trabajos realizados').fill('Cambio de aceite\nRevisión de frenos');
  await page.getByRole('button', { name: 'Agregar refacción' }).click();
  await page.getByLabel('Refacción 1', { exact: true }).fill('Filtro de aceite');
  await submit(page, 'Registrar trabajo', 'Guardar trabajo');
  await expect(page.getByRole('status')).toHaveText('Trabajo guardado.');
  await expect(page.getByRole('listitem').filter({ hasText: 'Revisión de frenos' })).toBeVisible();
  await page.getByRole('button', { name: 'Registrar costos' }).click();
  await page.getByRole('button', { name: 'Agregar costo' }).click();
  await page.getByLabel('Importe 1').fill('1500.50');
  await page.getByLabel('Moneda 1').fill('MXN');
  await submit(page, 'Registrar costos', 'Guardar costos');
  await expect(page.getByRole('status')).toHaveText('Costos guardados.');
  await expect(page.getByText('Mano de obra: 1,500.50 MXN')).toBeVisible();
  await page.getByRole('button', { name: 'Registrar término' }).click();
  await page.getByLabel('Fecha real del servicio').fill(day(0));
  await page.getByLabel('Kilometraje del servicio').fill('150');
  await submit(page, 'Registrar término');
  await expect(page.getByLabel('Estado: Terminada')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar orden' }).click();
  await pick(page, 'Estado del vehículo al cerrar', 'Activo');
  await submit(page, 'Cerrar orden');
  await expect(page.getByLabel('Estado: Cerrada')).toBeVisible();
  await expectNoViolations(page);

  const closures = await a.database.rows<{ event_id: string }>(
    `SELECT event_id FROM ${AUDIT_TABLES.outbox} WHERE tenant_id = ? AND type = 'maintenance.order.preventive_closed' AND entity_id = ?`,
    [a.tenantId, orderId],
  );
  expect(closures).toHaveLength(1);
  const ids = closures.map((closure) => closure.event_id);
  await makeEventsAvailable(a.database, a.tenantId, ids);
  await deliverOutboxEvents(a.platform, a.database, a.tenantId, ids);

  await page.getByRole('button', { name: 'Volver a órdenes' }).click();
  await page.getByRole('tab', { name: 'Planes' }).click();
  await page.getByRole('button', { name: vehicleId }).click();
  await expect(page.getByText(`Siguiente objetivo por fecha: ${shown(day(30))}`)).toBeVisible();
  await expect(page.getByText(/Todavía no se alcanza ningún objetivo/)).toBeVisible();
  const occurrences = await a.database.rows<{ state: string }>(
    `SELECT state FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id = ? AND plan_id = ?`,
    [a.tenantId, plan?.id],
  );
  expect(occurrences).toEqual([{ state: 'completed' }]);
});

test('a role without view_costs sees the closed order without any amount', async ({ page }) => {
  await signIn(page, a, 'e2e-editor-a');
  await page.getByRole('button', { name: 'Orden preventiva' }).click();
  await expect(page.getByText('Filtro de aceite · 1')).toBeVisible();
  expect(await page.content()).not.toMatch(/1,500|150050|MXN|unitCost/);
  const raw = await page.evaluate(
    async (id) => (await fetch(`/api/v1/work-orders/${id}`)).text(),
    orderId,
  );
  expect(raw).not.toMatch(/150050|MXN|"costs"/);
});

test('an internal mechanic sees only their assigned order, works it and never sees costs (D9, FR-096)', async ({
  page,
  browser,
}) => {
  const mechanicMember = await a.member('viewer', 'e2e-mech-a');
  await signIn(page, a, 'e2e-admin-a');
  const me = (await page.evaluate(async () => (await fetch('/api/auth/session')).json())) as {
    user: { id: string };
  };

  // The administrator registers the internal mechanic (linked to the member) through the catalog.
  await page.getByRole('tab', { name: 'Talleres y mecánicos' }).click();
  const mechanicForm = page.getByRole('form', { name: 'Nuevo mecánico' });
  await mechanicForm.getByLabel(/Nombre del mecánico/).fill('Mecánico E2E');
  await mechanicForm.getByLabel('Vínculo', { exact: true }).click();
  await page.getByRole('option', { name: 'Interno (usuario de la empresa)' }).click();
  await mechanicForm.getByLabel('Usuario de la empresa', { exact: true }).click();
  await page.getByRole('option', { name: new RegExp(mechanicMember) }).click();
  await mechanicForm.getByRole('button', { name: 'Agregar mecánico' }).click();
  await expect(page.getByRole('table', { name: '1 mecánicos' })).toBeVisible();

  // Two corrective orders; only the first is assigned to the mechanic.
  const create = async (description: string) => {
    await page.getByRole('tab', { name: 'Órdenes', exact: true }).click();
    await page.getByRole('button', { name: 'Nueva orden correctiva' }).click();
    const form = page.getByRole('form', { name: 'Nueva orden correctiva' });
    await form.getByLabel(/^Vehículo/).fill(vehicleId);
    await form.getByLabel(/Descripción de la falla/).fill(description);
    await form.getByRole('button', { name: 'Registrar orden' }).click();
    await expect(page.getByLabel('Estado: Programada')).toBeVisible();
  };
  await create('Falla del mecánico E2E');
  await page.getByRole('button', { name: 'Asignar' }).click();
  await page.getByLabel('Persona responsable (usuario)').fill(me.user.id);
  await pick(page, 'Mecánico', 'Mecánico E2E (interno)');
  await page.getByLabel('Fecha programada').fill(day(0));
  await submit(page, 'Asignar');
  await expect(page.getByLabel('Estado: Asignada')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a órdenes' }).click();
  await create('Falla sin asignar E2E');

  // The mechanic signs in: the server returns exactly the assigned order.
  const mechanicContext = await browser.newContext();
  const mechanicPage = await mechanicContext.newPage();
  try {
    await signIn(mechanicPage, a, 'e2e-mech-a');
    await expect(mechanicPage.getByText('Falla del mecánico E2E')).toBeVisible();
    await expect(mechanicPage.getByText('Falla sin asignar E2E')).toHaveCount(0);
    await mechanicPage.getByRole('tab', { name: 'Mis órdenes' }).click();
    await expect(
      mechanicPage.getByRole('heading', { name: 'Mis órdenes', level: 1 }),
    ).toBeVisible();
    await expect(
      mechanicPage.getByRole('heading', { name: 'Falla del mecánico E2E', level: 2 }),
    ).toBeVisible();
    await expect(mechanicPage.getByRole('button', { name: /^Abrir (para|orden)/ })).toHaveCount(1);
    await expectNoViolations(mechanicPage);

    const unassigned = (
      await a.database.rows<{ id: string }>(
        `SELECT id FROM opslog_maintenance_work_orders WHERE company_id = ? AND description = ?`,
        [a.tenantId, 'Falla sin asignar E2E'],
      )
    )[0]?.id as string;
    const api = await mechanicPage.evaluate(async (foreign) => {
      const json = async (path: string) => {
        const response = await fetch(path);
        return { status: response.status, body: (await response.text()) as string };
      };
      return {
        orders: await json('/api/v1/work-orders'),
        foreign: await json(`/api/v1/work-orders/${foreign}`),
        plans: await json('/api/v1/maintenance/plans'),
        mechanics: await json('/api/v1/maintenance/mechanics'),
      };
    }, unassigned);
    expect((JSON.parse(api.orders.body) as unknown[]).length).toBe(1);
    expect(api.foreign.status).toBe(404);
    expect(JSON.parse(api.plans.body)).toEqual([]);
    const mechanics = JSON.parse(api.mechanics.body) as { memberId: string }[];
    expect(mechanics.map((m) => m.memberId)).toEqual([mechanicMember]);

    // The mechanic starts, records the work and completes it; costs and closing are not offered.
    await mechanicPage.getByRole('button', { name: /Abrir para iniciar trabajo/i }).click();
    await mechanicPage.getByRole('button', { name: 'Iniciar trabajo' }).click();
    await submit(mechanicPage, 'Iniciar trabajo');
    await expect(mechanicPage.getByLabel('Estado: En proceso')).toBeVisible();
    await mechanicPage.getByRole('button', { name: 'Registrar trabajo' }).click();
    await mechanicPage.getByLabel('Trabajos realizados').fill('Diagnóstico del tablero');
    await submit(mechanicPage, 'Registrar trabajo', 'Guardar trabajo');
    await expect(mechanicPage.getByRole('status')).toHaveText('Trabajo guardado.');
    await mechanicPage.getByRole('button', { name: 'Registrar término' }).click();
    await mechanicPage.getByLabel('Fecha real del servicio').fill(day(0));
    await mechanicPage.getByLabel('Kilometraje del servicio').fill('160');
    await submit(mechanicPage, 'Registrar término');
    await expect(mechanicPage.getByLabel('Estado: Terminada')).toBeVisible();
    await expect(mechanicPage.getByRole('button', { name: 'Registrar costos' })).toHaveCount(0);
    await expect(mechanicPage.getByRole('button', { name: 'Cerrar orden' })).toHaveCount(0);
    expect(await mechanicPage.content()).not.toMatch(/MXN|unitCost|amountMinor/);
  } finally {
    await mechanicContext.close();
  }
});

test('tenant B, on its own database, sees nothing of tenant A', async ({ page }) => {
  await signIn(page, b, 'e2e-admin-b');
  await expect(page.getByText('Aún no hay órdenes')).toBeVisible();
  const foreign = await page.evaluate(
    async (id) => (await fetch(`/api/v1/work-orders/${id}`)).status,
    orderId,
  );
  const unknown = await page.evaluate(
    async () => (await fetch('/api/v1/work-orders/00000000-0000-4000-8000-0000000000aa')).status,
  );
  expect([foreign, unknown]).toEqual([404, 404]);
});

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(results.violations).toEqual([]);
}
