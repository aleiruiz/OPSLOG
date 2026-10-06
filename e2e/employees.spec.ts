import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission (including view_pii);
// "despacho" can view, create and edit (no archive, no personal data); "consulta" can only view; "datos" holds view,
// create and view_pii.
const admin = 'cuenta-admin';
const dispatch = 'cuenta-despacho';
const viewer = 'cuenta-consulta';
const piiReader = 'cuenta-datos';
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

const PERSONAL = /EJEM800101HDFXXX01|\+525555550101|empleado1@ejemplo\.test|LIC-100001/;

test.describe('employees: list, keyboard and accessibility', () => {
  test('is reachable from the navigation group "Plantilla" and lists employees', async ({
    page,
  }) => {
    await signIn(page, '/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByText('Plantilla', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Empleados' }).click();
    await expect(page.getByRole('heading', { name: 'Empleados', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'García López, Ana', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nuevo empleado' })).toBeVisible();
  });

  test('filters by kind and status, and loads more with the cursor', async ({ page }) => {
    await signIn(page, '/plantilla/empleados');
    await expect(page.getByRole('heading', { name: 'Empleados', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Cargar más empleados' }).click();
    await page.getByLabel('Tipo', { exact: true }).selectOption('dispatcher');
    await expect(page.getByRole('table', { name: 'Empleados (6)' })).toBeVisible();
    await page.getByLabel('Estado', { exact: true }).selectOption('terminated');
    await expect(page.getByRole('table', { name: 'Empleados (1)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on every employee screen, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados');
    await expect(page.getByRole('link', { name: 'García López, Ana', exact: true })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((entry) => entry.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/plantilla/empleados/emp-001');
    await expect(page.getByRole('heading', { name: 'Ana García López', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Línea de tiempo' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Mostrar datos personales' }).click();
    await expect(page.getByText('+525555550101')).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/plantilla/empleados/emp-007');
    await expect(page.getByRole('heading', { name: 'Empleado dado de baja' })).toBeVisible();
    await expectNoViolations(page);

    for (const [path, heading] of [
      ['/plantilla/empleados/emp-001/editar', 'Editar empleado'],
      ['/plantilla/empleados/nuevo', 'Nuevo empleado'],
    ] as const) {
      await goTo(page, path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('form', { name: heading })).toBeVisible();
      await expectNoViolations(page);
    }
    await page.getByRole('button', { name: 'Crear empleado' }).click();
    await expect(page.getByText('Escribe el nombre.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/plantilla/empleados');
    for (const path of [
      '/plantilla/empleados',
      '/plantilla/empleados/emp-001',
      '/plantilla/empleados/emp-001/editar',
      '/plantilla/empleados/nuevo',
    ]) {
      await goTo(page, path);
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
});

test.describe('employees: roles and personal data', () => {
  test('keeps personal data out of the page until an authorized person asks for it', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-001');
    await expect(page.getByRole('heading', { name: 'Ana García López', level: 1 })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(PERSONAL);
    await page.getByRole('button', { name: 'Mostrar datos personales' }).click();
    await expect(page.getByText('+525555550101')).toBeVisible();
    await page.getByRole('button', { name: 'Ocultar datos personales' }).click();
    await expect(page.locator('body')).not.toContainText(PERSONAL);
  });

  test('shows a masked placeholder and no edit actions to roles without the permission', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-001', dispatch);
    await expect(page.getByRole('heading', { name: 'Ana García López', level: 1 })).toBeVisible();
    await expect(page.getByText('Datos personales protegidos')).toBeVisible();
    await expect(page.getByRole('button', { name: /datos personales/i })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PERSONAL);
    await expect(page.getByRole('link', { name: 'Editar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);
    await goTo(page, '/plantilla/empleados/emp-001/editar');
    await expect(page.getByRole('form', { name: 'Editar empleado' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Teléfono/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/plantilla/empleados', viewer);
    await expect(page.getByRole('link', { name: 'Nuevo empleado' })).toHaveCount(0);
    await goTo(page, '/plantilla/empleados/nuevo');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/plantilla/empleados/emp-001/editar');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('lets the personal-data reader see the data but not change the employee', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-001', piiReader);
    await page.getByRole('button', { name: 'Mostrar datos personales' }).click();
    await expect(page.getByText('+525555550101')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  });
});

test.describe('employees: create and edit', () => {
  test('creates an employee with the keyboard, focusing the first invalid field first', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/nuevo');
    await expect(page.getByRole('form', { name: 'Nuevo empleado' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear empleado' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: /^Tipo de empleado/ })).toBeFocused();
    await page.getByRole('combobox', { name: /^Tipo de empleado/ }).selectOption('dispatcher');
    await fillByKeyboard(page, /^Nombre/, 'Rosa');
    await fillByKeyboard(page, /^Apellidos/, 'Vega Luna');
    await page.getByRole('combobox', { name: /^Área/ }).selectOption('area-sur');
    await fillByKeyboard(page, /^Teléfono/, '+525555550177');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Rosa Vega Luna', level: 1 })).toBeVisible();
    await expect(page.getByText('Empleado creado.')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('reports a duplicate employee number next to its field', async ({ page }) => {
    await signIn(page, '/plantilla/empleados/nuevo');
    await page.getByRole('combobox', { name: /^Tipo de empleado/ }).selectOption('other');
    await fillByKeyboard(page, /^Número de empleado/, 'e-0001');
    await fillByKeyboard(page, /^Nombre/, 'Rosa');
    await fillByKeyboard(page, /^Apellidos/, 'Vega Luna');
    await page.getByRole('combobox', { name: /^Área/ }).selectOption('area-sur');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Hay datos que ya existen')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Número de empleado/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('edits an employee: the kind is locked and the area is chosen from a list', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-001/editar');
    await expect(page.getByRole('combobox', { name: /^Tipo de empleado/ })).toBeDisabled();
    await fillByKeyboard(page, /^Puesto/, 'Líder de reparto');
    await page.getByRole('combobox', { name: /^Área/ }).selectOption('area-sur');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ana García López', level: 1 })).toBeVisible();
    await expect(page.getByText('Líder de reparto').first()).toBeVisible();
  });
});

test.describe('employees: status and archive dialogs', () => {
  test('changes the status with a reason, announcing the result', async ({ page }) => {
    await signIn(page, '/plantilla/empleados/emp-002');
    await page.getByRole('button', { name: 'Cambiar estado' }).click();
    const panel = page.getByRole('form', { name: 'Cambiar estado' });
    await panel.getByRole('button', { name: 'Cambiar estado' }).click();
    await expect(page.getByText('Elige el nuevo estado.')).toBeVisible();
    await panel.getByLabel(/^Nuevo estado/).selectOption('suspended');
    await panel.getByLabel(/^Motivo/).fill('Revisión interna');
    await panel.getByRole('button', { name: 'Cambiar estado' }).click();
    await expect(page.getByText('Estado cambiado a Suspendido.')).toBeVisible();
    await expect(page.getByText('Estado: de Activo a Suspendido').first()).toBeVisible();
  });

  test('traps and restores focus in the termination dialog, closes with Escape and confirms', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-002');
    await page.getByRole('button', { name: 'Cambiar estado' }).click();
    const panel = page.getByRole('form', { name: 'Cambiar estado' });
    await panel.getByLabel(/^Nuevo estado/).selectOption('terminated');
    await panel.getByLabel(/^Motivo/).fill('Renuncia voluntaria');
    await panel.getByRole('button', { name: 'Cambiar estado' }).click();
    const dialog = page.getByRole('dialog', { name: 'Dar de baja a Luis Hernández Ruiz' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expectNoViolations(page);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await panel.getByRole('button', { name: 'Cambiar estado' }).click();
    await dialog.getByRole('button', { name: 'Dar de baja' }).click();
    await expect(page.getByText('Empleado dado de baja.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Empleado dado de baja' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  });

  test('archives an employee after confirming, and makes the record read-only', async ({
    page,
  }) => {
    await signIn(page, '/plantilla/empleados/emp-003');
    const trigger = page.getByRole('button', { name: 'Archivar' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /^Archivar a / });
    await expect(dialog).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Archivar empleado' }).click();
    await expect(page.getByText('Empleado archivado.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Empleado archivado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);
  });
});
