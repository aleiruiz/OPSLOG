import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accounts of the fake identity provider used by the mock API: admin has every permission; "despacho" can view,
// create and edit but not view personal data; "consulta" can only view.
const admin = 'cuenta-admin';
const dispatch = 'cuenta-despacho';
const viewer = 'cuenta-consulta';
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const header = 'economicNumber,plate,make,model,year,areaId,odometerKm';
const csv = [
  header,
  'ECO-E2E1,NEW-501,Nissan,NP300,2022,area-norte,1200',
  'ECO-E2E2,NEW-502,Toyota,Hilux,2023,area-norte,800',
  'ECO-E2E3,,Nissan,NP300,2022,area-norte,100',
].join('\n');

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

test.describe('imports: history, permissions and accessibility', () => {
  test('lists the jobs with filters and cursor pagination, reachable from the navigation', async ({
    page,
  }) => {
    await signIn(page, '/');
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Importaciones' })
      .click();
    await expect(page.getByRole('heading', { name: 'Importaciones', level: 1 })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Importaciones (28)' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Cargar más importaciones' }).click();
    await expect(page.getByRole('row')).toHaveCount(29);
    await page.getByLabel('Qué se importó').selectOption('employee');
    await expect(page.getByRole('table', { name: /^Importaciones \(\d+\)$/ })).not.toHaveText(
      /Importaciones \(28\)/,
    );
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('table', { name: 'Importaciones (28)' })).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations on the history, detail and form, with contrast measured', async ({
    page,
  }) => {
    await signIn(page, '/flota/importaciones');
    await expect(page.getByRole('table', { name: 'Importaciones (28)' })).toBeVisible();
    const list = await expectNoViolations(page);
    expect(
      list.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(5);

    await goTo(page, '/flota/importaciones/imp-001');
    await expect(
      page.getByRole('heading', { name: 'Importación de vehículos', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: /^Filas \(/ })).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, '/flota/importaciones/nueva');
    await expect(page.getByRole('heading', { name: 'Nueva importación', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(page.getByText('Pega las filas o carga un archivo CSV.')).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/flota/importaciones');
    await expect(page.getByRole('table', { name: 'Importaciones (28)' })).toBeVisible();
    const headings: Record<string, string> = {
      '/flota/importaciones/imp-001': 'Importación de vehículos',
      '/flota/importaciones/nueva': 'Nueva importación',
      '/flota/importaciones': 'Importaciones',
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

  test('shows only the actions the role allows', async ({ page }) => {
    await signIn(page, '/flota/importaciones', viewer);
    await expect(page.getByRole('table', { name: 'Importaciones (28)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nueva importación' })).toHaveCount(0);
    await goTo(page, '/flota/importaciones/nueva');
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('imports: validate, confirm and personal data', () => {
  test('validates a pasted file, reads the report without values and imports the valid rows', async ({
    page,
  }) => {
    await signIn(page, '/flota/importaciones/nueva');
    await expect(page.getByRole('heading', { name: 'Nueva importación', level: 1 })).toBeVisible();
    await page.getByRole('textbox', { name: /Contenido CSV/ }).fill(csv);
    await expect(page.getByText('Detectamos 3 filas y 7 columnas.')).toBeVisible();
    await page.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(page.getByRole('heading', { name: 'Resultado de la validación' })).toBeVisible();
    const report = page.getByRole('table', { name: 'Filas con error (1)' });
    await expect(report).toBeVisible();
    await expect(report).toContainText('Falta un valor obligatorio');
    await expect(report).not.toContainText('ECO-E2E3');
    await expect(page.getByRole('button', { name: 'Importar todo', exact: true })).toBeDisabled();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Importar las 2 filas válidas' }).click();
    await expect(
      page.getByRole('heading', { name: 'Importación de vehículos', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText('Importación terminada. Revisa el informe por fila.'),
    ).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('asks to validate again when the file changes after validating', async ({ page }) => {
    await signIn(page, '/flota/importaciones/nueva');
    const box = page.getByRole('textbox', { name: /Contenido CSV/ });
    await box.fill(csv);
    await page.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(page.getByRole('heading', { name: 'Resultado de la validación' })).toBeVisible();
    await box.fill(`${csv}\nECO-E2E4,NEW-504,Nissan,NP300,2022,area-norte,5`);
    await expect(page.getByText(/Cambiaste el archivo después de validarlo/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Importar las/ })).toHaveCount(0);
  });

  test('warns a role without personal-data permission and blocks those columns', async ({
    page,
  }) => {
    await signIn(page, '/flota/importaciones/nueva', dispatch);
    await page.getByLabel(/^Registros a importar/).selectOption('employee');
    await expect(page.getByText(/Tu rol no puede importarlas/)).toBeVisible();
    await page
      .getByRole('textbox', { name: /Contenido CSV/ })
      .fill('kind,firstName,lastName,areaId,email\ndriver,Ana,Lopez,area-norte,a@ejemplo.test');
    await page.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(page.getByText(/incluye columnas con datos personales/)).toBeVisible();
    await expectNoViolations(page);
  });
});
