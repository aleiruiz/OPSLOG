import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission; "despacho" can
// view, create and edit (no deactivate); "consulta" can only view.
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

const item = (page: Page, name: RegExp) => page.getByRole('treeitem', { name });

test.describe('areas: tree, keyboard and accessibility', () => {
  test('is reachable from the navigation group "Plantilla" and shows the tree', async ({
    page,
  }) => {
    await signIn(page, '/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByText('Plantilla', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Áreas' }).click();
    await expect(page.getByRole('heading', { name: 'Áreas', level: 1 })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Estructura de áreas' })).toBeVisible();
    await expect(page.getByRole('treeitem')).toHaveCount(8);
  });

  test('operates the tree with the keyboard only: one tab stop, arrows, expand, collapse and open', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/areas');
    await expect(page.getByRole('tree')).toBeVisible();
    // Tab reaches the tree once: filter, expand/collapse buttons, then a single tab stop.
    await page.getByRole('button', { name: 'Contraer todo' }).focus();
    await page.keyboard.press('Tab');
    await expect(item(page, /^Centro/)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, /^Ciudad de México/)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, /^Centro/)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, /^Centro/)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(item(page, /^Centro/)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('End');
    await expect(item(page, /^Mérida/)).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(item(page, /^Norte/)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Norte', level: 1 })).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
  });

  test('has no WCAG 2.1 A/AA violations on every area screen, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/areas');
    await expect(page.getByRole('tree')).toBeVisible();
    await page.getByLabel('Estado', { exact: true }).selectOption('true');
    await page.getByRole('button', { name: 'Expandir todo' }).click();
    await expect(page.getByRole('treeitem', { name: /^Base Guadalupe/ })).toBeVisible();
    const tree = await expectNoViolations(page);
    expect(
      tree.passes.find((entry) => entry.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/plantilla/areas/area-norte-mty');
    await expect(page.getByRole('heading', { name: 'Monterrey', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Línea de tiempo' })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/plantilla/areas/area-mty-guadalupe');
    await expect(page.getByRole('heading', { name: 'Área inactiva' })).toBeVisible();
    await expectNoViolations(page);

    for (const [path, heading] of [
      ['/plantilla/areas/area-norte-mty/editar', 'Editar área'],
      ['/plantilla/areas/area-norte-mty/mover', 'Mover área'],
      ['/plantilla/areas/nueva', 'Nueva área'],
    ] as const) {
      await goTo(page, path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('form', { name: heading })).toBeVisible();
      await expectNoViolations(page);
    }
    await page.getByRole('button', { name: 'Crear área' }).click();
    await expect(page.getByText('Escribe el nombre del área.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/plantilla/areas');
    await expect(page.getByRole('tree')).toBeVisible();
    await page.getByRole('button', { name: 'Expandir todo' }).click();
    for (const path of [
      '/plantilla/areas',
      '/plantilla/areas/area-norte',
      '/plantilla/areas/area-apodaca-patio',
      '/plantilla/areas/area-norte-mty/editar',
      '/plantilla/areas/area-norte-mty/mover',
      '/plantilla/areas/nueva',
    ]) {
      await goTo(page, path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      if (path === '/plantilla/areas')
        await page.getByRole('button', { name: 'Expandir todo' }).click();
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
    await signIn(page, '/plantilla/areas/area-norte-mty', dispatch);
    await expect(page.getByRole('heading', { name: 'Monterrey', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Desactivar' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/plantilla/areas', viewer);
    await expect(page.getByRole('tree')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nueva área' })).toHaveCount(0);
    await goTo(page, '/plantilla/areas/nueva');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/plantilla/areas/area-sur/editar');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/plantilla/areas/area-sur/mover');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('areas: create, edit, move', () => {
  test('creates an area with the keyboard, focusing the first invalid field first', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/areas/nueva');
    await expect(page.getByRole('form', { name: 'Nueva área' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear área' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /Nombre/ })).toBeFocused();
    await fillByKeyboard(page, /Nombre/, 'Oeste');
    await fillByKeyboard(page, /Código/, 'oes');
    await fillByKeyboard(page, /Agregar responsable/, 'user-dispatch');
    await page.keyboard.press('Enter');
    await expect(page.getByText('user-dispatch')).toBeVisible();
    await page.getByRole('button', { name: 'Crear área' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Oeste', level: 1 })).toBeVisible();
    await expect(page.getByText('Área creada.')).toBeVisible();
    await expect(page.getByText('OES', { exact: true }).first()).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('reports a duplicate name next to its field', async ({ page }) => {
    await signIn(page, '/plantilla/areas/nueva');
    await fillByKeyboard(page, /Nombre/, 'norte');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Ya existe otra área con este nombre/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Nombre/ })).toBeFocused();
  });

  test('edits an area and moves it with its whole subtree', async ({ page }) => {
    await signIn(page, '/plantilla/areas/area-norte-mty/editar');
    await expect(page.getByRole('textbox', { name: /Nombre/ })).toHaveValue('Monterrey');
    await fillByKeyboard(page, /Nombre/, 'Monterrey Metro');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Monterrey Metro', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Mover' }).click();
    await expect(
      page.getByText('Se moverán también sus 4 sub-áreas con la misma estructura.'),
    ).toBeVisible();
    await page.getByLabel('Área superior').selectOption('area-sur');
    await page.getByRole('button', { name: 'Mover área' }).click();
    await expect(page.getByText('Área movida con todas sus sub-áreas.')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Ruta del área' }).getByRole('link', { name: 'Sur' }),
    ).toBeVisible();
  });
});

test.describe('areas: activation dialogs', () => {
  test('traps and restores focus, closes with Escape, and names what blocks a deactivation', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/areas/area-norte');
    await expect(page.getByRole('heading', { name: 'Norte', level: 1 })).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Desactivar' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Desactivar el área Norte' });
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
    await dialog.getByRole('button', { name: 'Desactivar área' }).click();
    await expect(dialog.getByRole('alert')).toContainText('todavía tiene sub-áreas activas');
    await expectNoViolations(page);
  });

  test('deactivates a free area, then activates it again', async ({ page }) => {
    await signIn(page, '/plantilla/areas/area-sur-mer');
    await page.getByRole('button', { name: 'Desactivar' }).click();
    await page.getByRole('button', { name: 'Desactivar área' }).click();
    await expect(page.getByText('Área desactivada.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Área inactiva' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Activar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Activar el área Mérida' });
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Activar área' }).click();
    await expect(page.getByText('Área activada.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toBeVisible();
  });

  test('blocks deactivating an area that holds vehicles', async ({ page }) => {
    await signIn(page, '/plantilla/areas/area-centro');
    await expect(page.getByText(/Para desactivar esta área primero resuelve/)).toBeVisible();
  });
});
