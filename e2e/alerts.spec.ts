import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission (including
// manage_config); "despacho" can view, create and edit; "consulta" can only view.
const admin = 'cuenta-admin';
const dispatch = 'cuenta-despacho';
const viewer = 'cuenta-consulta';
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function signIn(page: Page, path: string, subject = admin) {
  await page.goto(`/web${path}`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).focus();
  await page.keyboard.type(subject);
  await page.keyboard.press('Enter');
}

/** In-app navigation: the mock API lives in page memory, so a full page load would sign the person out. */
async function goTo(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState(null, '', `/web${target}`);
    window.dispatchEvent(new Event('opslog:navigate'));
  }, path);
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(results.violations).toEqual([]);
  return results;
}

async function fillByKeyboard(page: Page, label: RegExp, value: string) {
  const field = page.getByRole('spinbutton', { name: label });
  await field.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
}

test.describe('alerts: list, filters and links', () => {
  test('lists alerts with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Alertas', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Alertas', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más alertas' }).click();
    await expect(page.getByRole('row')).toHaveCount(35);
    await page.getByLabel('Estado', { exact: true }).selectOption('expired');
    await expect(page.getByRole('table', { name: 'Alertas (12)' })).toBeVisible();
    await page.getByLabel('Origen').selectOption('insurance_policy');
    await expect(page.getByRole('table', { name: /^Alertas \(\d+\)$/ })).not.toHaveText(
      /Alertas \(12\)/,
    );
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
  });

  test('links an alert to its document or policy', async ({ page }) => {
    await signIn(page, '/flota/alertas');
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
    await page
      .getByRole('link', { name: /^Ver seguro: / })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: /^Póliza POL-/, level: 1 })).toBeVisible();
    await goTo(page, '/flota/alertas');
    await page
      .getByRole('link', { name: /^Ver documento de vehículo: / })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Alertas');
    expect(new URL(page.url()).pathname).toMatch(/^\/web\/flota\/documentos\/doc-/);
  });

  test('summarises the alerts on the home page and links to the list', async ({ page }) => {
    await signIn(page, '/');
    await expect(page.getByText('12 vencidos')).toBeVisible();
    await expect(page.getByText('22 por vencer en 30 días')).toBeVisible();
    await expectNoViolations(page);
    await page
      .getByRole('region', { name: 'Vencimientos' })
      .getByRole('link', { name: 'Ver alertas' })
      .click();
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the list and the settings, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/alertas');
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/configuracion/alertas');
    await expect(page.getByRole('form', { name: 'Ajustes de alertas' })).toBeVisible();
    await expectNoViolations(page);
    await fillByKeyboard(page, /Días de anticipación/, '99');
    await page.getByRole('button', { name: 'Guardar ajustes' }).click();
    await expect(page.getByText('Escribe un número entero entre 1 y 30.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/alertas');
    await expect(page.getByRole('table', { name: 'Alertas (34)' })).toBeVisible();
    const headings: Record<string, string> = {
      '/': 'Inicio',
      '/configuracion/alertas': 'Ajustes de alertas',
      '/flota/alertas': 'Alertas',
    };
    for (const path of Object.keys(headings)) {
      await goTo(page, path);
      await expect(
        page.getByRole('heading', { name: headings[path] as string, level: 1 }),
      ).toBeVisible();
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });
});

test.describe('alert settings: permissions', () => {
  test('is editable with manage_config, and read-only for everyone else', async ({ page }) => {
    await signIn(page, '/configuracion/alertas');
    await expect(page.getByRole('form', { name: 'Ajustes de alertas' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Ajustes de alertas' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/configuracion/alertas', dispatch);
    await expect(page.getByRole('heading', { name: 'Ajustes de alertas', level: 1 })).toBeVisible();
    await expect(page.getByText(/Solo quien administra la configuración/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar ajustes' })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(
      page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Ajustes de alertas' }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/configuracion/alertas', viewer);
    await expect(page.getByText('30 días')).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('alert settings: save and conflicts', () => {
  test('saves the window and the recipients with the keyboard, and narrows the alerts', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/alertas');
    await expect(page.getByRole('form', { name: 'Ajustes de alertas' })).toBeVisible();
    await fillByKeyboard(page, /Días de anticipación/, '5');
    await page.getByRole('checkbox', { name: 'Consulta' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Consulta' })).toBeChecked();
    await page.getByRole('button', { name: 'Guardar ajustes' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Ajustes guardados.')).toBeVisible();
    await goTo(page, '/flota/alertas');
    await expect(page.getByText(/en los próximos 5 días/)).toBeVisible();
    await expect(page.getByRole('table', { name: /^Alertas \(\d+\)$/ })).not.toHaveText(
      /Alertas \(34\)/,
    );
  });

  test('focuses the first invalid field and sends nothing', async ({ page }) => {
    await signIn(page, '/configuracion/alertas');
    await expect(page.getByRole('form', { name: 'Ajustes de alertas' })).toBeVisible();
    await fillByKeyboard(page, /Días de anticipación/, '0');
    await page.getByRole('button', { name: 'Guardar ajustes' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('spinbutton', { name: /Días de anticipación/ })).toBeFocused();
    await expect(page.getByText('Escribe un número entero entre 1 y 30.')).toBeVisible();
    await expect(page.getByText('Ajustes guardados.')).toHaveCount(0);
  });

  test('tells the person when someone else saved first, and offers the current data', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/alertas');
    await expect(page.getByRole('form', { name: 'Ajustes de alertas' })).toBeVisible();
    await page
      .getByRole('button', { name: /Simular cambio ajeno en los ajustes de alertas/ })
      .click();
    await fillByKeyboard(page, /Días de anticipación/, '7');
    await page.keyboard.press('Enter');
    const alert = page.getByRole('alert').filter({ hasText: 'Otra persona cambió los ajustes' });
    await expect(alert).toBeVisible();
    await page.getByRole('button', { name: 'Cargar datos actuales' }).click();
    await expect(page.getByRole('spinbutton', { name: /Días de anticipación/ })).toHaveValue('21');
  });
});
