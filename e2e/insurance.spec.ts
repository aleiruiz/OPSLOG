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

test.describe('insurance: list, permissions and accessibility', () => {
  test('lists policies with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Seguros' })
      .click();
    await expect(page.getByRole('heading', { name: 'Seguros', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Pólizas (28)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más pólizas' }).click();
    await expect(page.getByRole('row')).toHaveCount(29);
    await page.getByLabel('Estado', { exact: true }).selectOption('expired');
    await expect(page.getByRole('table', { name: /^Pólizas \(\d+\)$/ })).not.toHaveText(
      /Pólizas \(28\)/,
    );
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Pólizas (28)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the list, detail and forms, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/seguros');
    await expect(page.getByRole('table', { name: 'Pólizas (28)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/flota/seguros/pol-002');
    await expect(page.getByRole('heading', { name: /^Póliza POL-/, level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/seguros/pol-002/editar');
    await expect(page.getByRole('heading', { name: 'Editar póliza', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/seguros/pol-002/renovar');
    await expect(page.getByRole('heading', { name: 'Renovar póliza', level: 1 })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/seguros/nueva');
    await expect(page.getByRole('heading', { name: 'Nueva póliza', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear póliza' }).click();
    await expect(page.getByText('Escribe el nombre de la aseguradora.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/seguros');
    await expect(page.getByRole('table', { name: 'Pólizas (28)' })).toBeVisible();
    const headings: Record<string, string | RegExp> = {
      '/flota/seguros/pol-002': /^Póliza POL-/,
      '/flota/seguros/pol-002/renovar': 'Renovar póliza',
      '/flota/seguros/nueva': 'Nueva póliza',
      '/flota/seguros': 'Seguros',
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

  test('shows only the actions the role allows, and never offers the deductible without view_costs', async ({
    page,
  }) => {
    await signIn(page, '/flota/seguros/nueva');
    await expect(page.getByRole('group', { name: 'Deducible' })).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/flota/seguros/nueva', dispatch);
    await expect(page.getByRole('heading', { name: 'Nueva póliza', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Deducible' })).toHaveCount(0);
    await expect(page.getByText(/requiere permiso para ver costos/)).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, '/flota/seguros', viewer);
    await expect(page.getByRole('table', { name: 'Pólizas (28)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nueva póliza' })).toHaveCount(0);
    await goTo(page, '/flota/seguros/nueva');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('insurance: create, renew and conflicts', () => {
  test('creates a policy with an exact deductible, focusing the first invalid field first', async ({
    page,
  }) => {
    await signIn(page, '/flota/seguros/nueva');
    await page.getByRole('button', { name: 'Crear póliza' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Vehículo asegurado')).toBeFocused();

    await page.getByLabel('Vehículo asegurado').selectOption('veh-001');
    await fillByKeyboard(page, /Aseguradora/, 'Seguros Demo');
    await fillByKeyboard(page, /Número de póliza/, 'pol-77');
    await page.getByLabel('Tipo de cobertura').selectOption('comprehensive');
    await page.getByLabel(/Inicio de vigencia/).fill('2026-11-01');
    await page.getByLabel(/Fin de vigencia/).fill('2027-10-31');
    await page.getByLabel('Tipo de deducible').selectOption('amount');
    await fillByKeyboard(page, /Monto del deducible/, '12500.50');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Póliza POL-77', level: 1 })).toBeVisible();
    await expect(page.getByText('Póliza creada.')).toBeVisible();
    await expect(page.getByText('12,500.50 MXN', { exact: true })).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('renews a policy and keeps the replaced revision in the history', async ({ page }) => {
    await signIn(page, '/flota/seguros/pol-002/renovar');
    await expect(page.getByRole('heading', { name: 'Renovar póliza', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Inicio de vigencia')).toHaveValue('2026-10-04');
    await page.getByRole('button', { name: 'Renovar póliza' }).click();
    await expect(page.getByText(/Póliza renovada/)).toBeVisible();
    await expect(page.getByText(/Reemplazada/).first()).toBeVisible();
  });

  test('tells the person when someone else changed the policy, and offers the current data', async ({
    page,
  }) => {
    await signIn(page, '/flota/seguros/pol-001/editar');
    await expect(page.getByRole('textbox', { name: /Aseguradora/ })).not.toHaveValue('');
    await page.getByRole('button', { name: /Simular cambio ajeno en la póliza/ }).click();
    await fillByKeyboard(page, /Aseguradora/, 'Mi aseguradora');
    await page.keyboard.press('Enter');
    const alert = page.getByRole('alert').filter({ hasText: 'Otra persona modificó esta póliza' });
    await expect(alert).toBeVisible();
    await page.getByRole('button', { name: 'Cargar datos actuales' }).click();
    await expect(page.getByRole('textbox', { name: /Aseguradora/ })).toHaveValue(
      'Cambiada por otra persona',
    );
  });
});

test.describe('insurance: archive confirmation dialog', () => {
  test('traps and restores focus, closes with Escape, and archives with confirmation', async ({
    page,
  }) => {
    await signIn(page, '/flota/seguros/pol-002');
    await expect(page.getByRole('heading', { name: /^Póliza POL-/, level: 1 })).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Archivar' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: /^Archivar la póliza/ });
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
    await dialog.getByRole('button', { name: 'Archivar póliza' }).click();
    await expect(page.getByText('Póliza archivada.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Póliza archivada' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  });
});
