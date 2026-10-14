import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { startRealStack, type RealTenant } from './real-api/harness.js';

const expect = baseExpect.configure({ timeout: 15_000 });

// INC-INTEGRATE browser journey: the whole life of a case on a 360 px phone, against the composed
// BFF over a disposable synthetic MySQL 8.4 database (one physical database per tenant). No mocks.
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const ORDERS = 'opslog_maintenance_work_orders';

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.use({ actionTimeout: 15_000, viewport: { width: 360, height: 740 } });
test.skip(!adminUrl && !process.env.CI, 'needs OPSLOG_TEST_MYSQL_ADMIN_URL (synthetic MySQL 8.4)');

let stack: Awaited<ReturnType<typeof startRealStack>>;
let a: RealTenant;
let vehicleId: string;
let caseId = '';
let folio = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  if (!adminUrl)
    throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; the journey must not skip');
  stack = await startRealStack();
  ({ a } = stack);
  vehicleId = await a.vehicle('IJ001');
  await a.member('viewer', 'ij-viewer-a');
  await a.member('auditor', 'ij-auditor-a');
  await a.member('incident_manager', 'ij-manager-a');
  const token = await adminToken('ij-admin-a');
  const year = new Date().getUTCFullYear();
  const policy = await a.platform.insurance.create(token, 'ij-policy', {
    vehicleId,
    insurer: 'Seguros IJ',
    policyNumber: 'POL-IJ-1',
    coverageType: 'comprehensive',
    startsOn: `${year - 1}-01-01`,
    endsOn: `${year + 1}-12-31`,
  });
  expect(JSON.stringify(policy)).toContain('"ok":true');
  // D20: the company bears more than 1,000.00 MXN only with a supervisor's approval.
  const settings = await a.platform.companySettings.update(token, 'ij-settings', 0, {
    expiryWindowDays: 7,
    recipientRoles: ['admin'],
    closeCostThreshold: { amountMinor: '100000', currency: 'MXN' },
  });
  expect(JSON.stringify(settings)).toContain('"ok":true');
});
test.afterAll(async () => {
  await stack?.close();
});

/** The tenant's administrator is `e2e-admin-a` in the harness: the account that bootstrapped it. */
async function adminToken(account: string) {
  const subject = account === 'ij-admin-a' ? 'e2e-admin-a' : account;
  const principal = await a.platform.verifyPrincipal(`fake-code:${subject}`, 'ij-nonce');
  if (!principal.ok || !principal.value) throw new Error('journey principal failed');
  const login = await a.platform.signIn(principal.value);
  if (!login.ok || !login.value) throw new Error('journey sign-in failed');
  return login.value.token;
}

const justNow = () => new Date(Date.now() - 60_000).toISOString().slice(0, 16);
const status = (page: Page, label: string) => page.getByLabel(`Estado: ${label}`);
const actions = (page: Page) => page.getByRole('region', { name: 'Acciones del caso' });
const submit = (page: Page, form: string, button = form) =>
  page.getByRole('form', { name: form }).getByRole('button', { name: button }).click();
const inRegion = (page: Page, name: string) =>
  page.getByRole('region', { name }).getByRole('button', { name });

async function signIn(page: Page, account: string, path: string) {
  await page.context().clearCookies();
  await page.goto(`${a.webUrl}/real${path}`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).fill(account);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(
    results.violations.map((item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`),
  ).toEqual([]);
}
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
}
/** A noisy JPEG made in the browser, so the photo is a real image the wizard compresses. */
async function photo(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;
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

test('a phone reports with a photo, and the case goes through review, rejection and appeal', async ({
  page,
}) => {
  await signIn(page, 'ij-manager-a', '/incidents/new');
  await expectNoHorizontalScroll(page);
  const image = await photo(page);
  await page.getByLabel(/^Tipo de siniestro/).selectOption('collision');
  await page.getByLabel(/^Vehículo/).selectOption(vehicleId);
  await page.getByLabel(/Fecha y hora del evento/).fill(justNow());
  await page.getByLabel('Ubicación').fill('Periférico km 12');
  await page.getByLabel('Descripción', { exact: true }).fill('Golpe visto desde el celular');
  await page.getByLabel('Gravedad').selectOption('medium');
  await page.getByLabel(/¿El vehículo puede operar/).selectOption('yes');
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page).toHaveURL(/paso=2/);
  await page.getByLabel('Motivo si no hay conductor').fill('Vehículo estacionado');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/paso=4/);
  await page.getByLabel('Tomar foto').setInputFiles({
    name: 'foto.jpg',
    mimeType: 'image/jpeg',
    buffer: image,
  });
  await expect(page.getByText('foto.jpg')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoViolations(page);
  await expect
    .poll(
      async () =>
        (
          await a.database.rows<{ n: number }>(
            'SELECT COUNT(*) AS n FROM opslog_incident_evidence WHERE company_id = ?',
            [a.tenantId],
          )
        )[0]?.n,
    )
    .toBe(1);
  await a.platform.pipeline.processScans();
  await page.reload();
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page.getByText('Listo para reportar')).toBeVisible();
  await page.getByRole('button', { name: 'Reportar' }).click();
  await expect(page).toHaveURL(/\/real\/incidents\/[^/?]+$/);
  caseId = new URL(page.url()).pathname.split('/').pop() as string;
  folio = (await page.getByRole('heading', { level: 1 }).textContent()) as string;
  await expectNoHorizontalScroll(page);
  await expectNoViolations(page);

  // Review and the insurer route.
  await page.getByRole('button', { name: 'Asignar responsable' }).click();
  await page.getByLabel(/Persona responsable/).selectOption({ label: 'Tú' });
  await submit(page, 'Asignar responsable', 'Asignar');
  await page.getByRole('button', { name: 'Iniciar revisión' }).click();
  await expect(status(page, 'En revisión')).toBeVisible();
  await page.getByRole('tab', { name: 'Seguro' }).click();
  await expect(page.getByText('POL-IJ-1')).toBeVisible();
  await page.getByLabel('Aseguradora', { exact: true }).fill('Seguros IJ');
  await page.getByLabel('Número de siniestro de la aseguradora').fill('SIN-IJ-1');
  await page.getByLabel('Día en que se avisó a la aseguradora').fill(justNow().slice(0, 10));
  await page.getByRole('button', { name: 'Guardar datos del seguro' }).click();
  await expect(page.getByText('Datos del seguro guardados.')).toBeVisible();
  await page.getByRole('button', { name: 'Pasar a la aseguradora' }).click();
  await expect(status(page, 'Con la aseguradora')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Rejection needs its letter; the appeal sends it back and the second rejection stands.
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('La aseguradora alega póliza vencida');
  await inRegion(page, 'Registrar rechazo').click();
  await expect(actions(page)).toContainText('Sube la carta de rechazo de la aseguradora.');
  await page.getByRole('tab', { name: 'Evidencia' }).click();
  await page.getByLabel('Categoría').selectOption('rejection_letter');
  await page.getByLabel('Adjuntar archivos').setInputFiles({
    name: 'carta.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%synthetic rejection letter\n'),
  });
  await expect(page.getByText(/aún no cuenta como evidencia/)).toBeVisible();
  await a.platform.pipeline.processScans();
  await page.reload();
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('La aseguradora alega póliza vencida');
  await inRegion(page, 'Registrar rechazo').click();
  await expect(status(page, 'Rechazado por la aseguradora')).toBeVisible();
  await page.getByRole('button', { name: 'Apelar' }).click();
  await page.getByLabel(/Nota de la apelación/).fill('Se anexa la vigencia de la póliza');
  await inRegion(page, 'Apelar').click();
  await expect(status(page, 'Con la aseguradora')).toBeVisible();
  await page.getByRole('button', { name: 'Registrar rechazo' }).click();
  await page.getByLabel(/Motivo del rechazo/).fill('Rechazo confirmado tras la apelación');
  await inRegion(page, 'Registrar rechazo').click();
  await expect(status(page, 'Rechazado por la aseguradora')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoViolations(page);
});

test('the company assumes the cost: an order created once from the sheet, approvals, closure and reopening', async ({
  page,
}) => {
  // 1,000.01 MXN against the 1,000.00 MXN threshold: one minor unit above it.
  const token = await adminToken('ij-admin-a');
  const [row] = await a.database.rows<{ version: number }>(
    'SELECT version FROM opslog_incident_incidents WHERE company_id = ? AND id = ?',
    [a.tenantId, caseId],
  );
  const costed = await a.platform.incidentCosts.update(
    token,
    'ij-costs',
    caseId,
    {
      version: row?.version,
      lines: [
        { kind: 'expense', category: 'towing', amount: { amountMinor: '100001', currency: 'MXN' } },
      ],
    },
    `ij-costs-key-${caseId}`,
  );
  expect(JSON.stringify(costed)).toContain('"ok":true');

  await signIn(page, 'ij-manager-a', `/incidents/${caseId}`);
  await page.getByRole('tab', { name: 'Resumen' }).click();
  await page.getByLabel('Resumen de la resolución').fill('La empresa asume el costo');
  await page.getByLabel('Estado en que queda el vehículo').selectOption('active');
  await page.getByLabel('¿La empresa asume el costo?').selectOption('yes');
  await page.getByRole('button', { name: 'Guardar resolución' }).click();
  await expect(page.getByText('Resolución guardada.')).toBeVisible();
  await expect(actions(page)).toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Marcar como resuelto' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await signIn(page, 'e2e-admin-a', `/incidents/${caseId}`);
  await page.getByRole('tab', { name: 'Resumen' }).click();
  await page.getByRole('button', { name: 'Aprobar asunción del costo' }).click();
  await expect(page.getByText('Aprobar asunción del costo: listo.')).toBeVisible();

  await page.getByRole('button', { name: 'Marcar como resuelto' }).click();
  await expect(status(page, 'Resuelto')).toBeVisible();

  // The closer is told that the closure needs a supervisor; the supervisor approves; the closer closes.
  await signIn(page, 'ij-manager-a', `/incidents/${caseId}`);
  await expect(actions(page)).toContainText('necesita la aprobación de una persona supervisora');
  await expect(page.getByRole('button', { name: 'Cerrar caso' })).toHaveCount(0);
  await signIn(page, 'e2e-admin-a', `/incidents/${caseId}`);
  await page.getByRole('button', { name: 'Aprobar cierre' }).click();
  await expect(page.getByText('Aprobar cierre: listo.')).toBeVisible();
  await signIn(page, 'ij-manager-a', `/incidents/${caseId}`);
  await page.getByRole('button', { name: 'Cerrar caso' }).click();
  await expect(status(page, 'Cerrado')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reabrir caso' })).toHaveCount(0);

  await signIn(page, 'e2e-admin-a', `/incidents/${caseId}`);
  await page.getByRole('button', { name: 'Reabrir caso' }).click();
  const reopen = page.getByRole('region', { name: 'Reabrir caso' });
  await reopen.getByLabel(/Motivo de la reapertura/).fill('El taller encontró más daño');
  await reopen.getByRole('button', { name: 'Reabrir caso' }).click();
  await expect(status(page, 'Reabierto')).toBeVisible();
  await expect(page.getByRole('heading', { name: folio, level: 1 })).toBeVisible();
  // The reopened case needs a repair: the order is created from the sheet, and a double click makes one.
  // (Orders still open would block a close, so this comes after the closure.)
  // A double click on "Crear orden y vincular" is one order, not two (the Idempotency-Key).
  await page.getByRole('tab', { name: 'Reparación' }).click();
  await page.getByRole('button', { name: 'Vincular orden' }).click();
  await page
    .getByRole('form', { name: 'Crear orden correctiva' })
    .getByRole('button', { name: 'Crear orden y vincular' })
    .dblclick();
  await expect(page.getByText('Orden creada y vinculada.')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Órdenes vinculadas' }).getByRole('listitem'),
  ).toHaveCount(1);
  expect(
    (
      await a.database.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${ORDERS} WHERE company_id = ?`,
        [a.tenantId],
      )
    )[0]?.n,
  ).toBe(1);
  await expectNoHorizontalScroll(page);
  await expectNoViolations(page);

  await expectNoHorizontalScroll(page);
  await expectNoViolations(page);
});

test('a restricted role sees no amounts, no threshold and no identity, and the vehicle sheet leads to its cases', async ({
  page,
}) => {
  const seen: string[] = [];
  page.on('response', async (response) => {
    if (/\/api\/(v1\/incidents|alerts\/settings)/.test(response.url()) && response.ok())
      seen.push(await response.text().catch(() => ''));
  });
  await signIn(page, 'ij-viewer-a', `/incidents/${caseId}`);
  await expect(page.getByRole('tab', { name: 'Costos' })).toHaveCount(0);
  await expect(page.getByText(/MXN|USD/)).toHaveCount(0);
  const settings = await page.evaluate(async () => {
    const reply = await fetch('/api/alerts/settings', { credentials: 'same-origin' });
    return { status: reply.status, text: await reply.text() };
  });
  expect(settings.status).toBe(200);
  expect(settings.text).not.toMatch(/closeCostThreshold|amountMinor/);
  expect(seen.join('\n')).not.toMatch(/amountMinor/);
  await expectNoViolations(page);

  // The vehicle sheet offers the cases of the vehicle to whoever may see incidents, and only to them.
  await page.goto(`${a.webUrl}/real/flota/vehiculos/${vehicleId}`);
  await page.getByRole('link', { name: 'Siniestros del vehículo' }).click();
  await expect(page).toHaveURL(new RegExp(`/real/incidents\\?vehicleId=${vehicleId}`));
  await expect(page.getByText('Mostrando solo los siniestros de un vehículo.')).toBeVisible();
  await expect(page.getByText(folio).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await signIn(page, 'ij-auditor-a', `/flota/vehiculos/${vehicleId}`);
  await expect(page.getByRole('link', { name: 'Siniestros del vehículo' })).toHaveCount(0);
});
