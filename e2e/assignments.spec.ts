import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission; "consulta" can only view.
const admin = 'cuenta-admin';
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

async function ready(page: Page) {
  await expect(page.getByLabel(/^Vehículo/)).toBeVisible();
  await expect(page.getByRole('option', { name: /Ana García López/ })).toBeAttached();
}

test.describe('assignments: list, history, permissions and accessibility', () => {
  test('lists assignments with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Asignaciones' })
      .click();
    await expect(page.getByRole('heading', { name: 'Asignaciones', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Asignaciones (28)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más asignaciones' }).click();
    await expect(page.getByRole('row')).toHaveCount(29);
    await page.getByLabel('Estado', { exact: true }).selectOption('current');
    await expect(page.getByRole('table', { name: /^Asignaciones \(\d+\)$/ })).not.toHaveText(
      /Asignaciones \(28\)/,
    );
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Asignaciones (28)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the list, detail and forms, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/asignaciones');
    await expect(page.getByRole('table', { name: 'Asignaciones (28)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/flota/asignaciones/asg-001');
    await expect(
      page.getByRole('heading', { name: /^Asignación de ECO-/, level: 1 }),
    ).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/asignaciones/asg-001/cerrar');
    await expect(page.getByRole('heading', { name: 'Cerrar asignación', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/asignaciones/nueva');
    await expect(page.getByRole('heading', { name: 'Nueva asignación', level: 1 })).toBeVisible();
    await ready(page);
    await page.getByRole('button', { name: 'Crear asignación' }).click();
    await expect(page.getByText('Elige el vehículo.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/asignaciones');
    await expect(page.getByRole('table', { name: 'Asignaciones (28)' })).toBeVisible();
    const headings: Record<string, string | RegExp> = {
      '/flota/asignaciones/asg-001': /^Asignación de ECO-/,
      '/flota/asignaciones/asg-001/cerrar': 'Cerrar asignación',
      '/flota/asignaciones/nueva': 'Nueva asignación',
      '/flota/asignaciones': 'Asignaciones',
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

  test('shows only the actions the role allows', async ({ page }) => {
    await signIn(page, '/flota/asignaciones', viewer);
    await expect(page.getByRole('table', { name: 'Asignaciones (28)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nueva asignación' })).toHaveCount(0);
    await goTo(page, '/flota/asignaciones/nueva');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await goTo(page, '/flota/asignaciones/asg-001');
    await expect(
      page.getByRole('heading', { name: /^Asignación de ECO-/, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cerrar asignación' })).toHaveCount(0);
    await expectNoViolations(page);
  });
});

test.describe('assignments: create, replace and end', () => {
  test('assigns a secondary driver, focusing the first invalid field first', async ({ page }) => {
    await signIn(page, '/flota/asignaciones/nueva');
    await ready(page);
    await page.getByRole('button', { name: 'Crear asignación' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/^Vehículo/)).toBeFocused();
    await page.getByLabel(/^Vehículo/).selectOption('veh-001');
    await page.getByLabel(/^Conductor/).selectOption('emp-010');
    await page.getByLabel(/^Tipo/).selectOption('secondary');
    await page.getByRole('textbox', { name: /Motivo de la asignación/ }).focus();
    await page.keyboard.type('Apoyo en rutas largas');
    await page.getByRole('button', { name: 'Crear asignación' }).click();
    await expect(page.getByText('Asignación creada.')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /^Asignación de ECO-001/, level: 1 }),
    ).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('explains the BR-002 conflict and replaces the principal on request', async ({ page }) => {
    await signIn(page, '/flota/asignaciones/nueva');
    await ready(page);
    await page.getByLabel(/^Vehículo/).selectOption('veh-001');
    await page.getByLabel(/^Conductor/).selectOption('emp-010');
    await page.getByLabel(/^Tipo/).selectOption('principal');
    await page.getByRole('textbox', { name: /Motivo de la asignación/ }).fill('Cambio de titular');
    await page.getByRole('button', { name: 'Crear asignación' }).click();
    await expect(
      page.getByRole('heading', { name: 'El vehículo ya tiene un conductor principal' }),
    ).toBeVisible();
    await expect(page.getByText(/BR-002/)).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Reemplazar al principal actual' }).click();
    await expect(page.getByText(/Asignación creada/)).toBeVisible();
    await expect(page.getByText(/reemplazó/i).first()).toBeVisible();
  });

  test('explains the BR-003 conflict next to the driver', async ({ page }) => {
    await signIn(page, '/flota/asignaciones/nueva');
    await ready(page);
    await page.getByLabel(/^Vehículo/).selectOption('veh-005');
    await page.getByLabel(/^Conductor/).selectOption('emp-001');
    await page.getByRole('textbox', { name: /Motivo de la asignación/ }).fill('Cobertura');
    await page.getByRole('button', { name: 'Crear asignación' }).click();
    await expect(
      page.getByRole('heading', { name: 'El conductor ya es principal de otro vehículo' }),
    ).toBeVisible();
    await expect(page.getByLabel(/^Conductor/)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Reemplazar al principal actual' })).toHaveCount(
      0,
    );
  });

  test('ends an assignment with a reason and keeps it in the history', async ({ page }) => {
    await signIn(page, '/flota/asignaciones/asg-001/cerrar');
    await expect(page.getByRole('heading', { name: 'Cerrar asignación', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar asignación' }).click();
    await expect(page.getByText(/Escribe el motivo/)).toBeVisible();
    await page.getByRole('textbox', { name: /Motivo/ }).fill('Fin de la ruta');
    await page.getByRole('button', { name: 'Cerrar asignación' }).click();
    await expect(page.getByText(/Asignación cerrada/).first()).toBeVisible();
    await goTo(page, '/flota/asignaciones/asg-001/cerrar');
    await expect(page.getByText('Esta asignación ya está cerrada')).toBeVisible();
  });
});
