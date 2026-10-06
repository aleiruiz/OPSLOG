import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission; "despacho" can
// view, create and edit (no archive); "consulta" can only view.
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
  const field = page.getByRole('textbox', { name: label });
  await field.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
}

test.describe('documents: list, permissions and accessibility', () => {
  test('lists documents with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Documentos' })
      .click();
    await expect(page.getByRole('heading', { name: 'Documentos', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Documentos (28)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más documentos' }).click();
    await expect(page.getByRole('row')).toHaveCount(29);
    await page.getByLabel('Estado', { exact: true }).selectOption('expired');
    await expect(page.getByRole('table', { name: /^Documentos \(\d+\)$/ })).not.toHaveText(
      /Documentos \(28\)/,
    );
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Documentos (28)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the list, detail and forms, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/documentos');
    await expect(page.getByRole('table', { name: 'Documentos (28)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/flota/documentos/doc-002');
    await expect(
      page.getByRole('heading', { name: /^Verificación técnica/, level: 1 }),
    ).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/documentos/doc-002/editar');
    await expect(page.getByRole('heading', { name: 'Editar documento', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/documentos/doc-002/renovar');
    await expect(page.getByRole('heading', { name: 'Renovar documento', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/documentos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo documento', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear documento' }).click();
    await expect(page.getByText('Escribe el título del documento.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/documentos');
    await expect(page.getByRole('table', { name: 'Documentos (28)' })).toBeVisible();
    const headings: Record<string, string | RegExp> = {
      '/flota/documentos/doc-002': /^Verificación técnica/,
      '/flota/documentos/doc-002/renovar': 'Renovar documento',
      '/flota/documentos/nuevo': 'Nuevo documento',
      '/flota/documentos': 'Documentos',
    };
    for (const path of Object.keys(headings)) {
      await goTo(page, path);
      await expect(
        page.getByRole('heading', { name: headings[path] as string | RegExp, level: 1 }),
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

  test('shows only the actions the role allows, and explains a missing permission', async ({
    page,
  }) => {
    await signIn(page, '/flota/documentos/doc-002', dispatch);
    await expect(
      page.getByRole('heading', { name: /^Verificación técnica/, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/flota/documentos', viewer);
    await expect(page.getByRole('table', { name: 'Documentos (28)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nuevo documento' })).toHaveCount(0);
    await goTo(page, '/flota/documentos/nuevo');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/flota/documentos/doc-002/renovar');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('documents: create, renew and conflicts', () => {
  test('creates a document with the keyboard, focusing the first invalid field first', async ({
    page,
  }) => {
    await signIn(page, '/flota/documentos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo documento', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear documento' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: /^Vehículo/ })).toBeFocused();
    await expect(page.getByText('Elige el vehículo del documento.')).toBeVisible();

    await page.getByRole('combobox', { name: /^Vehículo/ }).selectOption('veh-001');
    await page.getByLabel('Tipo de documento').selectOption('registration_card');
    await fillByKeyboard(page, /Título/, 'Tarjeta 2026');
    await page.getByLabel(/Fecha de emisión/).fill('2026-01-10');
    await page.getByLabel(/Fecha de vencimiento/).fill('2027-01-10');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Tarjeta 2026', level: 1 })).toBeVisible();
    await expect(page.getByText('Documento creado.')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('renews a document and keeps the replaced revision in the history', async ({ page }) => {
    await signIn(page, '/flota/documentos/doc-002/renovar');
    await expect(page.getByRole('heading', { name: 'Renovar documento', level: 1 })).toBeVisible();
    await page.getByLabel(/Fecha de emisión/).fill('2026-10-01');
    await page.getByLabel(/Fecha de vencimiento/).fill('2027-10-01');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Documento renovado/)).toBeVisible();
    await expect(page.getByText(/Reemplazado/).first()).toBeVisible();
  });

  test('tells the person when someone else changed the document, and offers the current data', async ({
    page,
  }) => {
    await signIn(page, '/flota/documentos/doc-001/editar');
    await expect(page.getByRole('textbox', { name: /Título/ })).not.toHaveValue('');
    await page.getByRole('button', { name: /Simular cambio ajeno en el documento/ }).click();
    await fillByKeyboard(page, /Título/, 'Mi título');
    await page.keyboard.press('Enter');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Otra persona modificó este documento' });
    await expect(alert).toBeVisible();
    await page.getByRole('button', { name: 'Cargar datos actuales' }).click();
    await expect(page.getByRole('textbox', { name: /Título/ })).toHaveValue(
      'Cambiado por otra persona',
    );
  });
});

test.describe('documents: archive confirmation dialog', () => {
  test('traps and restores focus, closes with Escape, and archives with confirmation', async ({
    page,
  }) => {
    await signIn(page, '/flota/documentos/doc-002');
    await expect(
      page.getByRole('heading', { name: /^Verificación técnica/, level: 1 }),
    ).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Archivar' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: /^Archivar el documento/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expectNoViolations(page);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Archivar documento' }).click();
    await expect(page.getByText('Documento archivado.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Documento archivado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  });
});
