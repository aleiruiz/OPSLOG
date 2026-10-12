import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The maintenance feature against in-memory ports shaped like the accepted contracts
// (e2e/browser-app/maintenance.tsx). Integrated journeys against the real API belong to MNT-QA.
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(results.violations).toEqual([]);
}
async function open(page: Page, as: string) {
  await page.goto(`/maintenance.html?as=${as}`);
}

test.describe('maintenance: orders, calendar and costs', () => {
  test('list and calendar show the same orders and pass axe with contrast', async ({ page }) => {
    await open(page, 'admin');
    await expect(page.getByRole('table', { name: '3 órdenes' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('tab', { name: 'Calendario' }).click();
    await expect(page.getByRole('region', { name: 'Programadas el 14/10/2026' })).toContainText(
      'Frenos rechinan',
    );
    await expect(page.getByRole('region', { name: 'Sin fecha programada' })).toContainText(
      'Ruido en suspensión',
    );
    await expectNoViolations(page);
  });

  test('a person with view_costs sees exact amounts and closes with an explicit vehicle decision', async ({
    page,
  }) => {
    await open(page, 'admin');
    await page.getByRole('button', { name: 'Servicio de 10 000 km' }).click();
    await expect(page.getByText('Mano de obra: 1,250.00 MXN')).toBeVisible();
    await expect(page.getByText('Filtro de aceite · 1 · 450.50 MXN c/u')).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Cerrar orden' }).click();
    const form = page.getByRole('form', { name: 'Cerrar orden' });
    await form.getByRole('button', { name: 'Cerrar orden' }).click();
    await expect(page.getByRole('complementary', { name: 'Falta para continuar' })).toContainText(
      'Elige el estado del vehículo al cerrar.',
    );
    await expectNoViolations(page);
    await page.getByLabel('Estado del vehículo al cerrar').click();
    await page.getByRole('option', { name: 'Activo', exact: true }).click();
    await form.getByRole('button', { name: 'Cerrar orden' }).click();
    await expect(page.getByLabel('Estado: Cerrada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reabrir orden' })).toBeVisible();
  });

  test('without view_costs no amount or currency reaches the page', async ({ page }) => {
    await open(page, 'editor');
    await page.getByRole('button', { name: 'Servicio de 10 000 km' }).click();
    await expect(page.getByText('Filtro de aceite · 1')).toBeVisible();
    const html = await page.content();
    expect(html).not.toMatch(/450|1,250|125000|45050|MXN|unitCost/);
    await expect(page.getByRole('heading', { name: 'Costos' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cerrar orden' })).toHaveCount(0);
  });
});

test.describe('maintenance: my orders on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the mechanic sees only own orders, without horizontal scroll, and starts one by keyboard', async ({
    page,
  }) => {
    await open(page, 'mechanic');
    await expect(page.getByRole('heading', { name: 'Mis órdenes', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Frenos rechinan', level: 2 })).toBeVisible();
    await expect(page.getByText('Servicio de 10 000 km')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Abrir para iniciar trabajo' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Iniciar trabajo' }).focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('form', { name: 'Iniciar trabajo' })
      .getByRole('button', { name: 'Iniciar trabajo' })
      .click();
    await expect(page.getByLabel('Estado: En proceso')).toBeVisible();
    await expect(page.getByText(/Sugerencia: el vehículo queda bloqueado/)).toBeVisible();
    const after = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(after).toBeLessThanOrEqual(0);
    await expectNoViolations(page);
  });
});

test.describe('maintenance: plans and catalog', () => {
  test('plans and the workshop catalog pass axe and keep external mechanics without accounts', async ({
    page,
  }) => {
    await open(page, 'admin');
    await page.getByRole('tab', { name: 'Planes' }).click();
    await page.getByRole('button', { name: 'veh-001' }).click();
    await expect(page.getByText('Siguiente objetivo por fecha: 01/11/2026')).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('tab', { name: 'Talleres y mecánicos' }).click();
    await expect(page.getByRole('table', { name: '2 mecánicos' })).toContainText(
      'Externo (sin cuenta)',
    );
    await expectNoViolations(page);
  });
});
