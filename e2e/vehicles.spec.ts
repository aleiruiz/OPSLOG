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

test.describe('vehicles: list, permissions and accessibility', () => {
  test('lists vehicles with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Vehículos' })
      .click();
    await expect(page.getByRole('heading', { name: 'Vehículos', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Vehículos (28)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más vehículos' }).click();
    await expect(page.getByRole('row')).toHaveCount(29);

    await page.getByLabel('Estado', { exact: true }).selectOption('in_maintenance');
    await expect(page.getByRole('table', { name: 'Vehículos (3)' })).toBeVisible();
    await fillByKeyboard(page, /Identificador de área/, 'area-sin-flota');
    await expect(page.getByText('Sin resultados')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Vehículos (28)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the list, detail and forms, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/vehiculos');
    await expect(page.getByRole('table', { name: 'Vehículos (28)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await page.getByRole('link', { name: 'ECO-001', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vehículo ECO-001', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('link', { name: 'Editar' }).click();
    await expect(page.getByRole('heading', { name: 'Editar vehículo', level: 1 })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Número económico/ })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/vehiculos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo vehículo', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear vehículo' }).click();
    await expect(page.getByText('Escribe el número económico.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/vehiculos');
    await expect(page.getByRole('table', { name: 'Vehículos (28)' })).toBeVisible();
    for (const path of [
      '/flota/vehiculos/veh-001',
      '/flota/vehiculos/veh-001/editar',
      '/flota/vehiculos/nuevo',
      '/flota/vehiculos',
    ]) {
      await page.evaluate((target) => {
        window.history.pushState(null, '', `/web${target}`);
        window.dispatchEvent(new Event('opslog:navigate'));
      }, path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
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
    await signIn(page, '/flota/vehiculos/veh-001', dispatch);
    await expect(page.getByRole('heading', { name: 'Vehículo ECO-001', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/flota/vehiculos', viewer);
    await expect(page.getByRole('table', { name: 'Vehículos (28)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nuevo vehículo' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Editar/ })).toHaveCount(0);
    await goTo(page, '/flota/vehiculos/nuevo');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/flota/vehiculos/veh-001/editar');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('vehicles: create, edit and conflicts', () => {
  test('creates a vehicle with the keyboard, focusing the first invalid field first', async ({
    page,
  }) => {
    await signIn(page, '/flota/vehiculos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo vehículo', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear vehículo' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /Número económico/ })).toBeFocused();
    await expect(page.getByText('Escribe el número económico.')).toBeVisible();

    await fillByKeyboard(page, /Número económico/, 'ECO-901');
    await fillByKeyboard(page, /Placa/, 'zz-901');
    await fillByKeyboard(page, /Marca/, 'Toyota');
    await fillByKeyboard(page, /Modelo/, 'Hiace');
    await fillByKeyboard(page, /Año/, '2023');
    await fillByKeyboard(page, /Identificador de área/, 'area-sur');
    await fillByKeyboard(page, /Odómetro/, '1200');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Vehículo ECO-901', level: 1 })).toBeVisible();
    await expect(page.getByText('Vehículo creado.')).toBeVisible();
    await expect(page.getByText('ZZ-901')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('reports a duplicate economic number next to its field', async ({ page }) => {
    await signIn(page, '/flota/vehiculos/nuevo');
    await fillByKeyboard(page, /Número económico/, 'eco-002');
    await fillByKeyboard(page, /Placa/, 'NEW-001');
    await fillByKeyboard(page, /Marca/, 'Ford');
    await fillByKeyboard(page, /Modelo/, 'Ranger');
    await fillByKeyboard(page, /Año/, '2022');
    await fillByKeyboard(page, /Identificador de área/, 'area-sur');
    await fillByKeyboard(page, /Odómetro/, '10');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Ya existe un vehículo con este número económico.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Número económico/ })).toBeFocused();
  });

  test('refuses a lower odometer, and saves edits with a higher one', async ({ page }) => {
    await signIn(page, '/flota/vehiculos/veh-001/editar');
    await expect(page.getByRole('textbox', { name: /Odómetro actual/ })).toHaveValue('15150');
    await fillByKeyboard(page, /Odómetro actual/, '100');
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('El odómetro no puede bajar: la lectura actual es 15,150 km.'),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Odómetro actual/ })).toBeFocused();

    await fillByKeyboard(page, /Odómetro actual/, '16000');
    await fillByKeyboard(page, /Marca/, 'Nissan Frontier');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    await expect(page.getByText('16,000 km')).toBeVisible();
  });

  test('tells the person when someone else changed the vehicle, and offers the current data', async ({
    page,
  }) => {
    await signIn(page, '/flota/vehiculos/veh-001/editar');
    await expect(page.getByRole('textbox', { name: /Marca/ })).toHaveValue('Nissan');
    await page.getByRole('button', { name: /Simular que otra persona edita/ }).click();
    await fillByKeyboard(page, /Marca/, 'Otra marca');
    await page.keyboard.press('Enter');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Otra persona modificó este vehículo' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Tus cambios no se guardaron');
    await page.getByRole('button', { name: 'Cargar datos actuales' }).click();
    await expect(page.getByRole('textbox', { name: /Odómetro actual/ })).toHaveValue('90000');
    await expect(page.getByRole('textbox', { name: /Marca/ })).toHaveValue('Nissan');
  });
});

test.describe('vehicles: archive confirmation dialog', () => {
  test('traps and restores focus, closes with Escape, and archives with confirmation', async ({
    page,
  }) => {
    await signIn(page, '/flota/vehiculos/veh-002');
    await expect(page.getByRole('heading', { name: 'Vehículo ECO-002', level: 1 })).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Archivar' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Archivar el vehículo ECO-002' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(/no se podrá editar/);
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expectNoViolations(page);

    // Focus never leaves the dialog while it is open.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Archivar vehículo' }).click();
    await expect(page.getByText('Vehículo archivado.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vehículo archivado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  });

  test('keeps the dialog open with a recoverable message when the vehicle changed meanwhile', async ({
    page,
  }) => {
    await signIn(page, '/flota/vehiculos/veh-001');
    await expect(page.getByRole('heading', { name: 'Vehículo ECO-001', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /Simular que otra persona edita/ }).click();
    await page.getByRole('button', { name: 'Archivar' }).click();
    await page.getByRole('button', { name: 'Archivar vehículo' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Otra persona modificó este vehículo');
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Recargar datos' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('90,000 km')).toBeVisible();
  });
});
