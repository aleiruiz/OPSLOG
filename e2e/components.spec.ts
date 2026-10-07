import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('OPSLOG UI components in a real browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders every existing exported component with accessible content', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Galería de componentes OPSLOG' }),
    ).toBeVisible();
    await expect(
      page.getByLabel('Estado: Activo. Severidad: Baja. Descripción: Procesamiento normal'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cargando' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Aún no hay registros' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sin resultados' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Información incompleta' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vencido' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cerrado' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Listo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sesión expirada' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeVisible();
    await expect(page.getByRole('group', { name: 'Formulario' })).toBeVisible();
    await expect(page.getByLabel('Severidad: Crítica')).toBeVisible();
    await expect(page.getByRole('search', { name: 'Filtros' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Tenants sintéticos' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Resumen' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Línea de tiempo' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Siguiente paso' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Notificaciones' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Archivos por cargar' })).toBeVisible();
  });

  test('supports keyboard and stateful interactions', async ({ page }) => {
    const filter = page.getByRole('textbox', { name: 'Filtrar' });
    await filter.fill('tenant');
    await expect(page.getByText('Filtro actual: tenant')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByText('Filtro actual: ninguno')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Seleccionar tenant-a' }).check();
    await expect(page.getByText('Seleccionados: tenant-a')).toBeVisible();
    await page.getByRole('tab', { name: 'Historial' }).click();
    await expect(page.getByText('Historial visible')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validar' })).toBeDisabled();
    await expect(page.getByText('Paso actual: 1')).toBeVisible();

    const reason = page.getByRole('textbox', { name: 'Motivo' });
    await reason.fill('fixture aprobado');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Motivo confirmado: fixture aprobado')).toBeVisible();
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(page.getByText('Reintento solicitado: error')).toBeVisible();
    await page.getByRole('button', { name: 'Reintentar estado' }).click();
    await expect(page.getByText('Estado reintentado')).toBeVisible();
  });

  test('has no WCAG 2.1 A/AA violations, including measured colour contrast', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Galería de componentes OPSLOG' }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
    // Contrast really was measured in the browser (jsdom cannot): many text nodes passed the rule. Axe reports
    // glyph-only icons and inputs behind the outline as "incomplete", which it cannot decide automatically.
    const contrast = results.passes.find((item) => item.id === 'color-contrast');
    expect(contrast?.nodes.length ?? 0).toBeGreaterThan(20);
  });

  test('keeps the accessibility tree of the component gallery stable', async ({ page }) => {
    await expect(page.locator('body')).toMatchAriaSnapshot({ name: 'gallery.aria.yml' });
  });

  test('applies the SPECS type scale to rendered text', async ({ page }) => {
    const size = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node).fontSize);
    expect(await size('h1')).toBe('22px');
    expect(await size('h2')).toBe('16px');
    expect(await size('body')).toBe('14px');
    expect(
      await page
        .locator('p')
        .first()
        .evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe('14px');
  });

  test('draws text-field borders with at least 3:1 contrast', async ({ page }) => {
    const border = await page
      .locator('.MuiOutlinedInput-notchedOutline')
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopColor);
    expect(border).toBe('rgb(107, 114, 128)');
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test('supports real keyboard navigation with a visible focus indicator', async ({ page }) => {
    const filter = page.getByRole('textbox', { name: 'Filtrar' });
    await filter.focus();
    await page.keyboard.type('tenant');
    await expect(page.getByText('Filtro actual: tenant')).toBeVisible();
    await expect(filter).toBeFocused();
    await expect(filter).toHaveCSS('outline-style', 'solid');
    await expect(filter).toHaveCSS('outline-width', '3px');

    const checkbox = page.getByRole('checkbox', { name: 'Seleccionar tenant-a' });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('Seleccionados: tenant-a')).toBeVisible();

    const tabs = page.getByRole('tab', { name: 'Resumen' });
    await tabs.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Historial' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Historial visible')).toBeVisible();

    const button = page.getByRole('button', { name: 'Limpiar filtros' });
    await button.focus();
    await expect(button).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Filtro actual: ninguno')).toBeVisible();
  });
});

test.describe('OPSLOG stories render and pass accessibility checks', () => {
  test('renders every story and has no WCAG 2.1 A/AA violations', async ({ page }) => {
    test.setTimeout(120_000); // one axe pass over every story page: grows with the catalogue
    await page.goto('/stories.html');
    await expect(page.getByRole('heading', { name: 'Stories OPSLOG' })).toBeVisible();
    // Foundations: StatusBadge, UiState and the base components each contribute stories.
    expect(await page.locator('main > section').count()).toBe(357);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
