import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const admin = { email: 'admin@demo.opslog.test', password: 'demo-password-123' };
const viewer = { email: 'consulta@demo.opslog.test', password: 'demo-password-456' };
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function signInWithKeyboard(page: Page, account: { email: string; password: string }) {
  await page.getByRole('textbox', { name: /Correo electrónico/ }).focus();
  await page.keyboard.type(account.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Contraseña/)).toBeFocused();
  await page.keyboard.type(account.password);
  await page.keyboard.press('Enter');
}

async function signIn(page: Page, path: string, account = admin) {
  await page.goto(`/web${path}`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await signInWithKeyboard(page, account);
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(results.violations).toEqual([]);
  return results;
}

test.describe('web shell: login, shell and navigation', () => {
  test('signs in with the keyboard only and shows company and user in the shell', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/usuarios');
    await expect(page.getByRole('heading', { name: 'Usuarios', level: 1 })).toBeVisible();
    await expect(page.getByTestId('shell-company')).toHaveText('Transportes Demo SA');
    await expect(page.getByTestId('shell-user')).toHaveText(
      'Ana Prueba · Administrador de empresa',
    );
    expect(new URL(page.url()).pathname).toBe('/web/configuracion/usuarios');
  });

  test('reaches the content through the skip link and moves between screens with the keyboard', async ({
    page,
  }) => {
    await signIn(page, '/');
    await expect(page.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar sesión' }).focus();
    await page.keyboard.press('Shift+Tab');
    const skip = page.getByRole('link', { name: 'Saltar al contenido' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();

    const roles = page.getByRole('link', { name: 'Roles' });
    await roles.focus();
    await expect(roles).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Roles', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toBeFocused();
    await expect(roles).toHaveAttribute('aria-current', 'page');

    await page.getByRole('button', { name: 'Ver Consulta' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Permisos de Consulta' })).toContainText(
      'Consultar información',
    );
    await page.getByRole('tab', { name: 'Permisos' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Crear copia' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: /Nombre del nuevo rol/ }).focus();
    await page.keyboard.type('Auditor externo');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Crear copia' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Rol "Auditor externo" creado.')).toBeVisible();
  });

  test('hides restricted navigation and shows the forbidden state for a read-only role', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/usuarios', viewer);
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByRole('link', { name: 'Inicio' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
    await expect(page.getByTestId('shell-user')).toHaveText('Luis Consulta · Consulta');
  });

  test('signs out and sends the person back to login', async ({ page }) => {
    await signIn(page, '/');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  });
});

test.describe('web shell: invitation, users and company', () => {
  test('accepts an invitation with the keyboard', async ({ page }) => {
    await page.goto('/web/invitacion/invitacion-vigente');
    await expect(page.getByText('Te invitaron a Transportes Demo SA')).toBeVisible();
    await page.getByRole('textbox', { name: /Nombre completo/ }).focus();
    await page.keyboard.type('Nueva Persona');
    await page.keyboard.press('Tab');
    await page.keyboard.type('una-contraseña-larga-123');
    await page.keyboard.press('Tab');
    await page.keyboard.type('una-contraseña-larga-123');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible();
    await expect(page.getByTestId('shell-user')).toContainText('Nueva Persona');
  });

  test('shows the same message for a link that does not exist', async ({ page }) => {
    await page.goto('/web/invitacion/token-inexistente');
    await expect(page.getByRole('heading', { name: 'Invitación no disponible' })).toBeVisible();
  });

  test('searches users, deactivates one with a reason and loads more rows', async ({ page }) => {
    await signIn(page, '/configuracion/usuarios');
    await expect(page.getByRole('table', { name: 'Usuarios (27)' })).toBeVisible();
    await page.getByRole('button', { name: 'Cargar más usuarios' }).click();
    await expect(page.getByRole('row')).toHaveCount(28);

    const search = page.getByRole('textbox', { name: 'Buscar por nombre o correo' });
    await search.focus();
    await page.keyboard.type('Diana');
    await page.keyboard.press('Enter');
    expect(new URL(page.url()).pathname).toBe('/web/configuracion/usuarios');
    await expect(page.getByRole('table', { name: 'Usuarios (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Desactivar a Diana Despacho' }).click();
    await page.getByRole('textbox', { name: /Motivo de la desactivación/ }).fill('Baja de prueba');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Diana Despacho fue desactivado.')).toBeVisible();
  });

  test('saves a security change only after the reason is confirmed', async ({ page }) => {
    await signIn(page, '/configuracion/empresa');
    const mfa = page.getByLabel('Verificación en dos pasos');
    await mfa.selectOption('required');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await page.getByRole('textbox', { name: /Motivo del cambio/ }).fill('Política interna');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
  });
});

test.describe('web shell: expired session and browser storage', () => {
  test('keeps the draft through an expired session and resumes after signing in again', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/empresa');
    const name = page.getByRole('textbox', { name: /Nombre de la empresa/ });
    await name.fill('Razón social en borrador');
    await expect(page.getByText('Borrador guardado.')).toBeVisible();

    await page.getByRole('button', { name: /Simular expiración/ }).click();
    await name.press('End');
    await page.keyboard.type(' v2', { delay: 10 });
    const panel = page.getByRole('group', { name: 'Sesión expirada' });
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    await expect(page.getByText(/Mantenemos estos cambios en esta pantalla/)).toBeVisible();

    await page.getByLabel(/^Contraseña/).focus();
    await page.keyboard.type(admin.password);
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(name).toHaveValue('Razón social en borrador v2');
    await expect(page.getByText('Borrador guardado.')).toBeVisible();
  });

  test('leaves localStorage, sessionStorage, cookies and IndexedDB empty after signing in and editing a draft', async ({
    page,
  }) => {
    await signIn(page, '/configuracion/empresa');
    await page.getByRole('textbox', { name: /Nombre de la empresa/ }).fill('Sin almacenamiento');
    await expect(page.getByText('Borrador guardado.')).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      cookie: document.cookie,
      databases: (await window.indexedDB.databases()).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0, cookie: '', databases: 0 });
  });
});

test.describe('web shell: accessibility and layout', () => {
  test('has no WCAG 2.1 A/AA violations on login and invitation, with contrast measured', async ({
    page,
  }) => {
    await page.goto('/web/iniciar-sesion');
    await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
    const login = await expectNoViolations(page);
    expect(
      login.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
    ).toBeGreaterThan(3);
    await page.goto('/web/invitacion/invitacion-vigente');
    await expect(page.getByRole('heading', { name: 'Aceptar invitación' })).toBeVisible();
    await expectNoViolations(page);
    await page.goto('/web/invitacion/otra');
    await expect(page.getByRole('heading', { name: 'Invitación no disponible' })).toBeVisible();
    await expectNoViolations(page);
  });

  for (const [path, heading] of [
    ['/', 'Inicio'],
    ['/configuracion/empresa', 'Empresa'],
    ['/configuracion/usuarios', 'Usuarios'],
    ['/configuracion/roles', 'Roles'],
  ] as const) {
    test(`has no WCAG 2.1 A/AA violations on ${heading} inside the shell`, async ({ page }) => {
      await signIn(page, path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Cargando' })).toHaveCount(0);
      const results = await expectNoViolations(page);
      expect(
        results.passes.find((item) => item.id === 'color-contrast')?.nodes.length ?? 0,
      ).toBeGreaterThan(5);
    });
  }

  test('has no violations in the forbidden and expired states', async ({ page }) => {
    await signIn(page, '/configuracion/usuarios', viewer);
    await expect(page.getByRole('heading', { name: 'No tienes acceso' })).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await signInWithKeyboard(page, admin);
    await page.getByRole('link', { name: 'Empresa' }).click();
    await expect(page.getByRole('textbox', { name: /Nombre de la empresa/ })).toBeVisible();
    await page.getByRole('button', { name: /Simular expiración/ }).click();
    await page.getByRole('textbox', { name: /Nombre de la empresa/ }).fill('x');
    await expect(page.getByRole('group', { name: 'Sesión expirada' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('does not overflow horizontally at 360px or 1280px', async ({ page }) => {
    await signIn(page, '/configuracion/usuarios');
    await expect(page.getByRole('table', { name: 'Usuarios (27)' })).toBeVisible();
    for (const path of ['usuarios', 'roles', 'empresa']) {
      await page.getByRole('link', { name: new RegExp(`^${path}$`, 'i') }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
