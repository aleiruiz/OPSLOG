import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Browser, type Page } from '@playwright/test';
import { startRealStack, type RealTenant } from './real-api/harness.js';

const expect = baseExpect.configure({ timeout: 15_000 });

// INC-UI PR 1 browser journeys: the real web shell against the composed BFF over a disposable
// synthetic MySQL 8.4 database (one physical database per tenant). No mocks and no fakes.
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const INCIDENTS = 'opslog_incident_incidents';
/** Evidence screenshots are only written when a directory is given (INC_UI_SHOTS). */
const shot = async (page: Page, name: string) => {
  const directory = process.env.INC_UI_SHOTS;
  if (directory)
    await page.screenshot({ path: `${directory}/${name}.png`, animations: 'disabled' });
};

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use({ actionTimeout: 15_000 });
test.skip(!adminUrl && !process.env.CI, 'needs OPSLOG_TEST_MYSQL_ADMIN_URL (synthetic MySQL 8.4)');

let stack: Awaited<ReturnType<typeof startRealStack>>;
let a: RealTenant;
let b: RealTenant;
let vehicleId: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  if (!adminUrl)
    throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; the journey must not skip');
  stack = await startRealStack();
  ({ a, b } = stack);
  vehicleId = await a.vehicle('E2E01');
  await a.member('editor', 'e2e-editor-a');
  await a.member('viewer', 'e2e-viewer-a');
  await a.member('auditor', 'e2e-auditor-a');
  await a.member('incident_manager', 'e2e-manager-a');
});
test.afterAll(async () => {
  await stack?.close();
});

/** A minute ago in the company's zone (UTC until the settings change it), as a datetime-local value. */
const justNow = () => new Date(Date.now() - 60_000).toISOString().slice(0, 16);

async function signIn(page: Page, tenant: RealTenant, account: string, path = '/incidents') {
  await page.goto(`${tenant.webUrl}/real${path}`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).fill(account);
  await page.keyboard.press('Enter');
}
async function expectNoViolations(page: Page, scope?: string) {
  const builder = new AxeBuilder({ page }).withTags(wcag);
  const results = await (scope ? builder.include(scope) : builder).analyze();
  expect(
    results.violations.map((item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`),
  ).toEqual([]);
}
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const culprits =
    overflow > 0
      ? await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter(
              (el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
            )
            .slice(0, 6)
            .map(
              (el) =>
                `${el.tagName}.${String(el.className).slice(0, 60)}[${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 30)}]`,
            ),
        )
      : [];
  expect({ overflow, culprits }).toEqual({ overflow: 0, culprits: [] });
}
async function incidentIds(tenant: RealTenant) {
  const rows = await tenant.database.rows<{ id: string; folio: string; status: string }>(
    `SELECT id, folio, status FROM ${INCIDENTS} WHERE company_id = ? ORDER BY created_at, id`,
    [tenant.tenantId],
  );
  return rows;
}
const submit = (page: Page, form: string, button = form) =>
  page.getByRole('form', { name: form }).getByRole('button', { name: button }).click();

test('draft: one folio on double click, resumes after a reload, lists what is missing and reports', async ({
  page,
}) => {
  await signIn(page, a, 'e2e-admin-a');
  await expect(page.getByRole('heading', { name: 'Siniestros', level: 1 })).toBeVisible();
  await expect(page.getByText('Aún no hay siniestros')).toBeVisible();
  await expectNoViolations(page);
  await page.getByRole('link', { name: 'Nuevo siniestro' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nuevo siniestro', level: 1 })).toBeVisible();
  await expectNoViolations(page);

  await page.getByLabel(/^Tipo de siniestro/).selectOption('collision');
  await page.getByLabel(/^Vehículo/).selectOption(vehicleId);
  await page.getByLabel('Descripción', { exact: true }).fill('Golpe lateral en el estacionamiento');
  await page.getByRole('button', { name: 'Crear' }).dblclick();
  await expect(page).toHaveURL(/borrador=.+&paso=2/);
  await expect(page.getByText('Borrador guardado.')).toBeVisible();
  expect(await incidentIds(a)).toHaveLength(1);
  const [draft] = await incidentIds(a);
  expect(draft?.status).toBe('draft');

  // Step 2 -> 3, then a hard reload resumes at step 3 with the saved data.
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page).toHaveURL(/paso=3/);
  await expect(page.getByRole('heading', { name: 'Terceros involucrados' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Terceros involucrados' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Nuevo siniestro/, level: 1 })).toBeVisible();
  await expect(page.getByText(`Borrador ${draft?.folio}`)).toBeVisible();
  await page.getByRole('button', { name: 'Agregar tercero' }).click();
  await page.getByLabel(/^Tipo de tercero/).selectOption('vehicle');
  await page.getByLabel('Nombre', { exact: true }).fill('Luis Gómez');
  await page.getByLabel('Placas').fill('XYZ-987');
  await submit(page, 'Agregar tercero', 'Guardar nuevo tercero');
  await expect(page.getByRole('listitem', { name: 'Vehículo 1' })).toContainText('Luis Gómez');
  await expectNoViolations(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/paso=4/);
  await expectNoViolations(page);

  // Report is not possible yet: the panel lists what the server says is missing.
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page).toHaveURL(/paso=5/);
  const missing = page.getByRole('complementary', { name: 'Falta para reportar' });
  await expect(missing).toContainText('Indica la fecha y hora del evento.');
  await expect(missing).toContainText('Indica la ubicación del evento.');
  await expect(missing).toContainText('Sube una foto');
  await expect(page.getByRole('button', { name: 'Reportar' })).toBeDisabled();
  await expectNoViolations(page);
  await shot(page, 'asistente-resumen-faltantes-escritorio');
  expect(await page.content()).not.toContain(draft?.id as string);

  // Complete the draft step by step and report it.
  await page.getByRole('button', { name: 'Evento', exact: true }).click();
  await page.getByLabel(/Fecha y hora del evento/).fill(justNow());
  await page.getByLabel('Ubicación').fill('Av. Reforma 100');
  await page.getByLabel('Gravedad').selectOption('medium');
  await page.getByLabel(/¿El vehículo puede operar/).selectOption('yes');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page).toHaveURL(/paso=2/);
  await page.getByLabel('Motivo si no hay conductor').fill('Vehículo estacionado');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Justificación si no hay foto').fill('El teléfono no tenía batería');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page.getByText('Listo para reportar')).toBeVisible();
  await page.getByRole('button', { name: 'Reportar' }).click();
  await expect(page).toHaveURL(new RegExp(`/real/incidents/${draft?.id}$`));
  await expect(page.getByRole('heading', { name: draft?.folio as string, level: 1 })).toBeVisible();
  await expect(page.getByText('Reportado', { exact: true }).first()).toBeVisible();
  await expectNoViolations(page);
  expect(await incidentIds(a)).toHaveLength(1);
});

/** A complete draft reported through the wizard; returns the case's folio and address. */
async function reportedCase(page: Page, description: string) {
  await page.goto(`${page.url().split('/real')[0]}/real/incidents/new`);
  await page.getByLabel(/^Tipo de siniestro/).selectOption('collision');
  await page.getByLabel(/^Vehículo/).selectOption(vehicleId);
  await page.getByLabel(/Fecha y hora del evento/).fill(justNow());
  await page.getByLabel('Ubicación').fill('Av. Reforma 100');
  await page.getByLabel('Descripción', { exact: true }).fill(description);
  await page.getByLabel('Gravedad').selectOption('medium');
  await page.getByLabel(/¿El vehículo puede operar/).selectOption('yes');
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page).toHaveURL(/borrador=.+&paso=2/);
  await page.getByLabel('Motivo si no hay conductor').fill('Vehículo estacionado');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Justificación si no hay foto').fill('El teléfono no tenía batería');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Reportar' }).click();
  await expect(page).toHaveURL(/\/real\/incidents\/[^/?]+$/);
  const folio = (await page.getByRole('heading', { level: 1 }).textContent()) as string;
  return { folio, path: new URL(page.url()).pathname.replace(/^\/real/, '') };
}
const status = (page: Page, label: string) => page.getByLabel(`Estado: ${label}`);
const actions = (page: Page) => page.getByRole('region', { name: 'Acciones del caso' });
/** Switches the browser to another account of the tenant and opens the same address. */
async function switchTo(page: Page, tenant: RealTenant, account: string, path: string) {
  await page.context().clearCookies();
  await signIn(page, tenant, account, path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
async function adminToken(tenant: RealTenant, subject: string) {
  const principal = await tenant.platform.verifyPrincipal(`fake-code:${subject}`, 'e2e-nonce');
  if (!principal.ok || !principal.value) throw new Error('e2e principal failed');
  const login = await tenant.platform.signIn(principal.value);
  if (!login.ok || !login.value) throw new Error('e2e sign-in failed');
  return login.value.token;
}

/** D20: the company defines a closing threshold, so the server asks for a supervisor's approval. */
async function configureThreshold(page: Page) {
  await signIn(page, a, 'e2e-admin-a', '/flota/mantenimiento');
  await page.getByRole('tab', { name: 'Configuración' }).click();
  await page.getByLabel(/Umbral de cierre costoso/).fill('1000');
  await page.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(page.getByText('Configuración guardada.')).toBeVisible();
}

/** Seeds a company-borne expense through the INC-COSTS port; the threshold in these journeys is 1000.00 MXN. */
async function seedCompanyCost(tenant: RealTenant, path: string, amountMinor: string) {
  const id = path.split('/').pop() as string;
  const token = await adminToken(tenant, 'e2e-admin-a');
  const [row] = await tenant.database.rows<{ version: number }>(
    `SELECT version FROM ${INCIDENTS} WHERE company_id = ? AND id = ?`,
    [tenant.tenantId, id],
  );
  const saved = await tenant.platform.incidentCosts.update(
    token,
    `e2e-costs-${id}`,
    id,
    {
      version: row?.version,
      lines: [{ kind: 'expense', category: 'towing', amount: { amountMinor, currency: 'MXN' } }],
    },
    `e2e-costs-key-${id}-${amountMinor}`,
  );
  expect(JSON.stringify(saved)).toContain('"ok":true');
}

test('workflow with D20: assign, review, resolve, supervisor approval, close and reopen', async ({
  page,
}) => {
  await configureThreshold(page);

  const { folio, path } = await reportedCase(page, 'Choque trasero en el estacionamiento');
  await expect(status(page, 'Reportado')).toBeVisible();
  await page.getByRole('button', { name: 'Asignar responsable' }).click();
  await page.getByLabel(/Persona responsable/).selectOption({ label: 'Tú' });
  await expectNoViolations(page);
  await submit(page, 'Asignar responsable', 'Asignar');
  await expect(page.getByText('Asignar responsable: listo.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar revisión' }).click();
  await expect(status(page, 'En revisión')).toBeVisible();
  await page.getByRole('button', { name: 'Continuar sin aseguradora' }).click();
  await page
    .getByLabel(/Por qué el caso sigue sin aseguradora/)
    .fill('La póliza no cubre daños propios');
  await page
    .getByRole('region', { name: 'Continuar sin aseguradora' })
    .getByRole('button', { name: 'Continuar sin aseguradora' })
    .click();
  await expect(status(page, 'Sin aseguradora')).toBeVisible();
  // The company bears 1000.01 MXN, one cent above the threshold, so D20 asks for an approval.
  await seedCompanyCost(a, path, '100001');
  await page.reload();
  await expect(status(page, 'Sin aseguradora')).toBeVisible();

  // What is missing to resolve comes from the server, in plain Spanish.
  await page.getByRole('button', { name: 'Marcar como resuelto' }).click();
  await expect(actions(page)).toContainText(
    'Marcar como resuelto: Escribe el resumen de la resolución.',
  );
  await expectNoViolations(page);
  await page.getByLabel('Resumen de la resolución').fill('Se repara con cargo a la empresa');
  await page.getByLabel('Estado en que queda el vehículo').selectOption('active');
  await page.getByLabel('¿La empresa asume el costo?').selectOption('yes');
  await page.getByRole('button', { name: 'Guardar resolución' }).click();
  await expect(page.getByText('Resolución guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como resuelto' }).click();
  await expect(status(page, 'Resuelto')).toBeVisible();

  // D20: the server asks for an approval before closing. The closer is told, and has no way around it.
  await switchTo(page, a, 'e2e-manager-a', path);
  await expect(actions(page)).toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Cerrar caso' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprobar cierre' })).toHaveCount(0);
  await expectNoViolations(page);

  await switchTo(page, a, 'e2e-admin-a', path);
  await page.getByRole('button', { name: 'Aprobar cierre' }).click();
  await expect(page.getByText('Aprobar cierre: listo.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprobar cierre' })).toHaveCount(0);

  await switchTo(page, a, 'e2e-manager-a', path);
  await page.getByRole('button', { name: 'Cerrar caso' }).click();
  await expect(status(page, 'Cerrado')).toBeVisible();

  // Closed: history, with the way back explained. The closer cannot reopen.
  await expect(actions(page)).toContainText('Caso cerrado: es historial');
  await expect(page.getByRole('button', { name: 'Editar datos del evento' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reabrir caso' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Evidencia' }).click();
  await expect(page.getByText(/no admite nuevos archivos/)).toBeVisible();
  await expect(page.getByLabel('Adjuntar archivos')).toHaveCount(0);
  await shot(page, 'caso-cerrado-evidencia-escritorio');
  await expectNoViolations(page);

  await switchTo(page, a, 'e2e-admin-a', path);
  await page.getByRole('button', { name: 'Reabrir caso' }).click();
  const reopen = page.getByRole('region', { name: 'Reabrir caso' });
  await expect(reopen.getByRole('button', { name: 'Reabrir caso' })).toBeDisabled();
  await expectNoViolations(page);
  await reopen.getByLabel(/Motivo de la reapertura/).fill('El taller encontró más daño');
  await reopen.getByRole('button', { name: 'Reabrir caso' }).click();
  await expect(status(page, 'Reabierto')).toBeVisible();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('Reabrir caso → Reabierto')).toBeVisible();
  await expect(page.getByRole('heading', { name: folio, level: 1 })).toBeVisible();
});

test('US-033: rejection with its letter, appeal, and the cost assumption waits for a supervisor', async ({
  page,
}) => {
  const token = await adminToken(a, 'e2e-admin-a');
  const policy = await a.platform.insurance.create(token, 'e2e-policy', {
    vehicleId,
    insurer: 'Seguros E2E',
    policyNumber: 'POL-E2E-1',
    coverageType: 'comprehensive',
    startsOn: `${new Date().getUTCFullYear() - 1}-01-01`,
    endsOn: `${new Date().getUTCFullYear() + 1}-12-31`,
  });
  expect(JSON.stringify(policy)).toContain('"ok":true');
  await configureThreshold(page);
  const { path } = await reportedCase(page, 'Choque con la barda');
  await page.getByRole('button', { name: 'Asignar responsable' }).click();
  await page.getByLabel(/Persona responsable/).selectOption({ label: 'Tú' });
  await submit(page, 'Asignar responsable', 'Asignar');
  await page.getByRole('button', { name: 'Iniciar revisión' }).click();
  await expect(status(page, 'En revisión')).toBeVisible();

  // The insurer data comes first; the policy that covered the event day is found by the server.
  await page.getByRole('tab', { name: 'Seguro' }).click();
  await expect(page.getByText('POL-E2E-1')).toBeVisible();
  await page.getByLabel('Aseguradora', { exact: true }).fill('Seguros E2E');
  await page.getByLabel('Número de siniestro de la aseguradora').fill('SIN-998');
  await page.getByLabel('Día en que se avisó a la aseguradora').fill(justNow().slice(0, 10));
  await page.getByRole('button', { name: 'Guardar datos del seguro' }).click();
  await expect(page.getByText('Datos del seguro guardados.')).toBeVisible();
  await expectNoViolations(page);
  await page.getByRole('button', { name: 'Pasar a la aseguradora' }).click();
  await expect(status(page, 'Con la aseguradora')).toBeVisible();

  // Rejection: the reason is stored, the letter is still missing and the panel says so.
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('La aseguradora alega póliza vencida');
  await page
    .getByRole('region', { name: 'Registrar rechazo' })
    .getByRole('button', { name: 'Registrar rechazo' })
    .click();
  await expect(actions(page)).toContainText('Sube la carta de rechazo de la aseguradora.');
  await page.getByRole('tab', { name: 'Evidencia' }).click();
  await page.getByLabel('Categoría').selectOption('rejection_letter');
  await page.getByLabel('Adjuntar archivos').setInputFiles({
    name: 'carta-rechazo.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%synthetic rejection letter\n'),
  });
  await expect(page.getByText(/En revisión: aún no cuenta como evidencia/)).toBeVisible();
  await expect(actions(page)).toContainText('Sube la carta de rechazo de la aseguradora.');
  await a.platform.pipeline.processScans();
  await page.reload();
  await expect(page.getByText('Guardado', { exact: true })).toBeVisible();
  await expect(actions(page)).not.toContainText('Sube la carta de rechazo');
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('La aseguradora alega póliza vencida');
  await page
    .getByRole('region', { name: 'Registrar rechazo' })
    .getByRole('button', { name: 'Registrar rechazo' })
    .click();
  await expect(status(page, 'Rechazado por la aseguradora')).toBeVisible();

  // Appeal returns the case to the insurer; rejecting again leaves the company with the cost.
  await page.getByRole('button', { name: 'Apelar' }).click();
  await page.getByLabel(/Nota de la apelación/).fill('Se anexa la vigencia de la póliza');
  await page
    .getByRole('region', { name: 'Apelar' })
    .getByRole('button', { name: 'Apelar' })
    .click();
  await expect(status(page, 'Con la aseguradora')).toBeVisible();
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('Rechazo confirmado tras la apelación');
  await page
    .getByRole('region', { name: 'Registrar rechazo' })
    .getByRole('button', { name: 'Registrar rechazo' })
    .click();
  await expect(status(page, 'Rechazado por la aseguradora')).toBeVisible();

  // Assumption (D20): with the threshold configured the supervisor approves before the case can go on.
  await seedCompanyCost(a, path, '100001');
  await page.reload();
  await page.getByRole('tab', { name: 'Resumen' }).click();
  await page.getByLabel('Resumen de la resolución').fill('La empresa asume el costo');
  await page.getByLabel('Estado en que queda el vehículo').selectOption('active');
  await page.getByLabel('¿La empresa asume el costo?').selectOption('yes');
  await page.getByRole('button', { name: 'Guardar resolución' }).click();
  await expect(page.getByText('Resolución guardada.')).toBeVisible();
  await expect(actions(page)).toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Marcar como resuelto' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprobar asunción del costo' })).toBeVisible();
  await expectNoViolations(page);

  await switchTo(page, a, 'e2e-manager-a', path);
  await expect(actions(page)).toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Aprobar asunción del costo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Marcar como resuelto' })).toHaveCount(0);

  await switchTo(page, a, 'e2e-admin-a', path);
  await page.getByRole('button', { name: 'Aprobar asunción del costo' }).click();
  await expect(page.getByText('Aprobar asunción del costo: listo.')).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como resuelto' }).click();
  await expect(status(page, 'Resuelto')).toBeVisible();
});

test('D20 acceptance 6: a cost at or below the threshold needs no approval and close is offered directly', async ({
  page,
}) => {
  await configureThreshold(page);
  const { path } = await reportedCase(page, 'Rozadura en el costado');
  await page.getByRole('button', { name: 'Asignar responsable' }).click();
  await page.getByLabel(/Persona responsable/).selectOption({ label: 'Tú' });
  await submit(page, 'Asignar responsable', 'Asignar');
  await page.getByRole('button', { name: 'Iniciar revisión' }).click();
  await page.getByRole('button', { name: 'Continuar sin aseguradora' }).click();
  await page.getByLabel(/Por qué el caso sigue sin aseguradora/).fill('Daño menor sin póliza');
  await page
    .getByRole('region', { name: 'Continuar sin aseguradora' })
    .getByRole('button', { name: 'Continuar sin aseguradora' })
    .click();
  await expect(status(page, 'Sin aseguradora')).toBeVisible();
  // Exactly the threshold (1000.00 MXN): equal does not ask.
  await seedCompanyCost(a, path, '100000');
  await page.reload();
  await page.getByLabel('Resumen de la resolución').fill('Se repara con cargo a la empresa');
  await page.getByLabel('Estado en que queda el vehículo').selectOption('active');
  await page.getByLabel('¿La empresa asume el costo?').selectOption('yes');
  await page.getByRole('button', { name: 'Guardar resolución' }).click();
  await expect(page.getByText('Resolución guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como resuelto' }).click();
  await expect(status(page, 'Resuelto')).toBeVisible();
  await expect(actions(page)).not.toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Aprobar cierre' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cerrar caso' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar caso' }).click();
  await expect(status(page, 'Cerrado')).toBeVisible();
});

/** A draft in another tenant, made through its own screens: only its id matters. */
async function foreignDraftId(browser: Browser) {
  const vehicle = await b.vehicle('E2EB01');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, b, 'e2e-admin-b', '/incidents/new');
  await page.getByLabel(/^Tipo de siniestro/).selectOption('collision');
  await page.getByLabel(/^Vehículo/).selectOption(vehicle);
  await page.getByLabel('Descripción', { exact: true }).fill('Caso de otra empresa');
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page).toHaveURL(/borrador=.+&paso=2/);
  const id = new URL(page.url()).searchParams.get('borrador') as string;
  await context.close();
  return id;
}

test('deep link keeps the filters, and a foreign case is a neutral 404', async ({
  page,
  browser,
}) => {
  await signIn(page, a, 'e2e-admin-a', '/incidents?status=resolved&limit=10');
  await expect(page.getByRole('heading', { name: 'Siniestros', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Estado', { exact: true })).toHaveValue('resolved');
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.nth(1)).toBeVisible();
  await expectNoViolations(page);
  await shot(page, 'lista-siniestros-escritorio');
  await rows.nth(1).getByRole('link').first().click();
  await expect(page).toHaveURL(/\/real\/incidents\/[^/?]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/status=resolved&limit=10/);
  await expect(page.getByLabel('Estado', { exact: true })).toHaveValue('resolved');
  await page.getByRole('button', { name: 'Críticos' }).click();
  await expect(page).toHaveURL(/severity=critical/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Siniestros', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/severity=critical/);

  const foreign = await foreignDraftId(browser);
  await page.goto(`${a.webUrl}/real/incidents/${foreign}`);
  await expect(page.getByText('No encontramos este siniestro')).toBeVisible();
  expect(await page.content()).not.toContain(foreign);
  await expectNoViolations(page);
});

test('permissions: view-only has no buttons, the fleet editor cannot start cases, the auditor sees nothing', async ({
  page,
}) => {
  const [first] = await incidentIds(a);
  const casePath = `/incidents/${first?.id}`;
  await signIn(page, a, 'e2e-viewer-a', '/incidents');
  await expect(page.getByRole('heading', { name: 'Siniestros', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nuevo siniestro' })).toHaveCount(0);
  await page.goto(`${a.webUrl}/real${casePath}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Terceros' }).click();
  await expect(page.getByRole('button', { name: /Agregar tercero|Editar|Retirar/ })).toHaveCount(0);
  await page.goto(`${a.webUrl}/real/incidents/new`);
  await expect(page.getByText('No tienes acceso')).toBeVisible();

  // Fleet editor: generic grants plus incidents:view, still no way to start a case.
  await switchTo(page, a, 'e2e-editor-a', '/incidents');
  await expect(page.getByRole('link', { name: 'Nuevo siniestro' })).toHaveCount(0);
  await page.goto(`${a.webUrl}/real/incidents/new`);
  await expect(page.getByText('No tienes acceso')).toBeVisible();
  await expectNoViolations(page);

  // Auditor: no incidents:view, so no entry in the navigation and the address says so.
  await switchTo(page, a, 'e2e-auditor-a', '/');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Siniestros' })).toHaveCount(
    0,
  );
  await page.goto(`${a.webUrl}/real/incidents`);
  await expect(page.getByText('No tienes acceso')).toBeVisible();
  await page.goto(`${a.webUrl}/real${casePath}`);
  await expect(page.getByText('No tienes acceso')).toBeVisible();
  await expectNoViolations(page);

  await switchTo(page, a, 'e2e-manager-a', '/incidents');
  await expect(page.getByRole('link', { name: 'Nuevo siniestro' }).first()).toBeVisible();
});

test('PII and costs: no identity without view_pii, no amounts in any incident response', async ({
  page,
}) => {
  const bodies: string[] = [];
  page.on('response', async (response) => {
    if (/\/api\/v1\/incidents/.test(response.url()) && response.ok())
      bodies.push(await response.text().catch(() => ''));
  });
  const [first] = await incidentIds(a);
  await signIn(page, a, 'e2e-manager-a', `/incidents/${first?.id}`);
  await page.getByRole('tab', { name: 'Terceros' }).click();
  await expect(page.getByRole('listitem', { name: 'Vehículo 1' })).toBeVisible();
  await expect(page.getByText('Datos de identidad restringidos', { exact: true })).toBeVisible();
  for (const secret of ['Luis Gómez', 'XYZ-987']) {
    await expect(page.getByText(secret)).toHaveCount(0);
    expect(await page.content()).not.toContain(secret);
  }
  await page.getByRole('tab', { name: 'Seguro' }).click();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoViolations(page);
  expect(bodies.length).toBeGreaterThan(3);
  const joined = bodies.join('\n');
  expect(joined).not.toContain('Luis Gómez');
  expect(joined).not.toContain('XYZ-987');
  expect(joined).not.toMatch(/amountMinor/);

  // The same case with view_pii shows the identity.
  await switchTo(page, a, 'e2e-admin-a', `/incidents/${first?.id}`);
  await page.getByRole('tab', { name: 'Terceros' }).click();
  await expect(page.getByText('Luis Gómez')).toBeVisible();
});

test('safe 409: the other edit is explained, Recargar keeps what was typed and resends only that', async ({
  page,
  browser,
}) => {
  const [first] = await incidentIds(a);
  const path = `/incidents/${first?.id}`;
  await signIn(page, a, 'e2e-admin-a', path);
  await page.getByRole('button', { name: 'Editar datos del evento' }).click();
  const form = page.getByRole('form', { name: 'Editar datos del evento' });
  await form.getByLabel('Descripción', { exact: true }).fill('Texto escrito antes del conflicto');

  // Somebody else saves in the meantime.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, a, 'e2e-manager-a', path);
  await otherPage.getByRole('button', { name: 'Editar datos del evento' }).click();
  await otherPage.getByLabel('Ubicación').fill('Calle 5 de Mayo 20');
  await submit(otherPage, 'Editar datos del evento', 'Guardar cambios');
  await expect(otherPage.getByText('Calle 5 de Mayo 20')).toBeVisible();
  await other.close();

  await submit(page, 'Editar datos del evento', 'Guardar cambios');
  const warning = page.getByRole('alert').filter({ hasText: /cambi/i });
  await expect(warning.first()).toBeVisible();
  await expectNoViolations(page);
  const patches: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH') patches.push(request.postData() ?? '');
  });
  await page.getByRole('button', { name: 'Recargar' }).first().click();
  await expect(form.getByLabel('Descripción', { exact: true })).toHaveValue(
    'Texto escrito antes del conflicto',
  );
  await expect(form.getByLabel('Ubicación')).toHaveValue('Calle 5 de Mayo 20');
  await submit(page, 'Editar datos del evento', 'Guardar cambios');
  await expect(page.getByText('Texto escrito antes del conflicto')).toBeVisible();
  expect(patches).toHaveLength(1);
  const sent = JSON.parse(patches[0] as string) as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual(['description', 'version']);
});

/** A noisy JPEG of roughly 8 MB, made in the browser (noise does not compress). */
async function bigJpeg(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2200;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = Math.random() * 255;
      image.data[i + 1] = Math.random() * 255;
      image.data[i + 2] = Math.random() * 255;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b as Blob), 'image/jpeg', 0.9),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}
interface Upload {
  key: string | undefined;
  body: { contentType: string; clientCompressed?: boolean; contentBase64: string; name: string };
}

test.describe('mobile 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('whole wizard with a photo: compressed once, one retry after a network cut, no horizontal scroll', async ({
    page,
  }) => {
    await signIn(page, a, 'e2e-manager-a', '/incidents/new');
    await expect(page.getByRole('heading', { name: 'Nuevo siniestro', level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoViolations(page);
    const photo = await bigJpeg(page);
    expect(photo.length).toBeGreaterThan(5 * 1024 * 1024);

    await page.getByLabel(/^Tipo de siniestro/).selectOption('collision');
    await page.getByLabel(/^Vehículo/).selectOption(vehicleId);
    await page.getByLabel(/Fecha y hora del evento/).fill(justNow());
    await page.getByLabel('Ubicación').fill('Periférico km 12');
    await page.getByLabel('Descripción', { exact: true }).fill('Golpe visto desde el celular');
    await page.getByLabel('Gravedad').selectOption('low');
    await page.getByLabel(/¿El vehículo puede operar/).selectOption('yes');
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect(page).toHaveURL(/paso=2/);
    await expectNoHorizontalScroll(page);
    await page.getByLabel('Motivo si no hay conductor').fill('Vehículo estacionado');
    await page.getByRole('button', { name: 'Guardar y continuar' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page).toHaveURL(/paso=4/);
    await expectNoHorizontalScroll(page);

    const uploads: Upload[] = [];
    let cut = 0;
    await page.route('**/api/v1/incidents/*/evidence', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      uploads.push({
        key: route.request().headers()['idempotency-key'],
        body: JSON.parse(route.request().postData() ?? '{}') as Upload['body'],
      });
      cut += 1;
      return cut === 1 ? route.abort('connectionreset') : route.fallback();
    });
    await page.getByLabel('Tomar foto').setInputFiles({
      name: 'foto-grande.jpg',
      mimeType: 'image/jpeg',
      buffer: photo,
    });
    await expect(page.getByText('foto-grande.jpg')).toBeVisible();
    await expect(
      page.getByRole('list', { name: /Evidencia/ }).or(page.getByText(/comprimida/)),
    ).toBeVisible({
      timeout: 60_000,
    });
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.key).toBeTruthy();
    expect(uploads[1]?.key).toBe(uploads[0]?.key);
    const sent = uploads[1]?.body as Upload['body'];
    expect(sent.clientCompressed).toBe(true);
    expect(sent.contentType).toBe('image/jpeg');
    expect((sent.contentBase64.length * 3) / 4).toBeLessThanOrEqual(2.3 * 1024 * 1024);
    expect(await page.getByRole('listitem').filter({ hasText: 'foto-grande' }).count()).toBe(1);
    await expectNoHorizontalScroll(page);
    await expectNoViolations(page);

    // The scan has to clear the photo before it counts as evidence (US-030).
    await a.platform.pipeline.processScans();
    await page.reload();
    await page.getByRole('button', { name: 'Guardar y continuar' }).click();
    await expect(page.getByText('Listo para reportar')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Reportar' }).click();
    await expect(page).toHaveURL(/\/real\/incidents\/[^/?]+$/);
    await expectNoHorizontalScroll(page);
    await expectNoViolations(page);
    await shot(page, 'caso-reportado-movil-360');

    // A PDF goes as it is, and a failed compression sends the original photo.
    await page.getByRole('tab', { name: 'Evidencia' }).click();
    await page.getByLabel('Categoría').selectOption('other');
    uploads.length = 0;
    await page.getByLabel('Adjuntar archivos').setInputFiles({
      name: 'parte.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%synthetic report\n'),
    });
    await expect(page.getByText('parte.pdf')).toBeVisible();
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]?.body.contentType).toBe('application/pdf');
    expect(uploads[0]?.body.clientCompressed).toBeUndefined();
    expect(uploads[0]?.body.name).toBe('parte.pdf');

    await page.evaluate(() => {
      window.createImageBitmap = () => Promise.reject(new Error('no bitmap'));
    });
    uploads.length = 0;
    await page.getByLabel('Categoría').selectOption('photo');
    await page.getByLabel('Tomar foto').setInputFiles({
      name: 'foto-original.jpg',
      mimeType: 'image/jpeg',
      buffer: photo,
    });
    await expect.poll(() => uploads.length, { timeout: 60_000 }).toBe(1);
    expect(uploads[0]?.body.clientCompressed).toBeUndefined();
    expect(uploads[0]?.body.name).toBe('foto-original.jpg');
    expect(Buffer.from(uploads[0]?.body.contentBase64 ?? '', 'base64').length).toBe(photo.length);
  });
});

test('keyboard: Escape closes the removal dialog and focus returns to its trigger', async ({
  page,
}) => {
  const [first] = await incidentIds(a);
  await signIn(page, a, 'e2e-admin-a', `/incidents/${first?.id}`);
  await page.getByRole('tab', { name: 'Terceros' }).click();
  const trigger = page.getByRole('button', { name: 'Retirar Vehículo 1' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Retirar tercero' });
  await expect(dialog).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  for (const tab of ['Resumen', 'Terceros', 'Evidencia', 'Seguro', 'Timeline']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectNoViolations(page);
  }
});
