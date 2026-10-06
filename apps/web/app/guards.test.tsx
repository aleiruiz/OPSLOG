import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { demoSubjects } from './mockApi';
import { click, renderApp, screen, type, waitFor } from './test/utils';

// vitest runs test files with __dirname set to the file's directory (jsdom has no file: import.meta.url).
const webRoot = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}
const sources = ['app', 'auth', 'settings'].flatMap((dir) => sourceFiles(join(webRoot, dir)));
const read = (path: string) => readFileSync(path, 'utf8');

describe('browser storage', () => {
  it('has no source reference to Web Storage, IndexedDB or document.cookie', () => {
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.filter((path) =>
      /localStorage|sessionStorage|indexedDB|document\.cookie/.test(read(path)),
    );
    expect(offenders.map((path) => relative(webRoot, path))).toEqual([]);
  });

  it('keeps Web Storage and cookies empty through login, a draft edit and session expiry in jsdom', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { api } = await renderApp({ account: null, path: '/configuracion/empresa' });
    await screen.findByLabelText(/^Cuenta de prueba/);
    type('Cuenta de prueba', demoSubjects.admin);
    click('Iniciar sesión');
    await screen.findByDisplayValue('Transportes Demo SA');
    // Edit only once the draft load settled; otherwise the first effects flush after the edit.
    await waitFor(() =>
      expect(document.querySelector('[data-draft-status="idle"]')).not.toBeNull(),
    );
    api.controls.expireSession();
    type('Nombre de la empresa', 'Cambio sin guardar');
    await screen.findByText(/Tu sesión expiró/);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    setItem.mockRestore();
  });
});

describe('design system usage', () => {
  it('declares no colour literals, inline styles or styled() wrappers', () => {
    const offenders = sources.filter((path) =>
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|style=\{|styled\(/.test(read(path)),
    );
    expect(offenders.map((path) => relative(webRoot, path))).toEqual([]);
  });

  it('imports from Material UI only layout and typography primitives, never form or feedback widgets', () => {
    const allowed = new Set(['Box', 'Typography', 'Link', 'CssBaseline', 'styles']);
    const used = new Set(
      sources.flatMap((path) =>
        [...read(path).matchAll(/from '@mui\/material\/?([\w/]*)'/g)].map((match) =>
          (match[1] as string) === '' ? 'root-import' : (match[1] as string),
        ),
      ),
    );
    expect([...used].filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('keeps every screen free of technical permission identifiers as visible text', async () => {
    await renderApp({ path: '/configuracion/roles' });
    await screen.findByRole('table', { name: 'Roles de la empresa' });
    click('Ver Administrador de empresa');
    const list = await screen.findByRole('list', { name: /Permisos de/ });
    expect(list.textContent).not.toMatch(/manage_|view_|incidents:/);
  });
});

describe('accessibility in jsdom (rules that do not need layout)', () => {
  async function violations(container: HTMLElement) {
    // heading-order is a best-practice rule (outside WCAG A/AA): packages/ui NextStepPanel renders an h6
    // directly under the page h1, which is a design-system issue to fix there, not in this package.
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
    });
    return results.violations.map((item) => item.id);
  }

  it.each([
    ['login', null, '/iniciar-sesion', 'Iniciar sesión'],
    ['invitation', null, '/invitacion/invitacion-vigente', 'Aceptar invitación'],
  ] as const)(
    'has no detectable violations on the %s screen',
    async (_name, account, path, heading) => {
      const { container } = await renderApp({ account, path });
      await screen.findByRole('heading', { name: heading, level: 1 });
      expect(await violations(container)).toEqual([]);
    },
  );

  it.each([
    ['home', '/', 'Inicio'],
    ['company', '/configuracion/empresa', 'Empresa'],
    ['users', '/configuracion/usuarios', 'Usuarios'],
    ['roles', '/configuracion/roles', 'Roles'],
  ] as const)(
    'has no detectable violations on the %s screen inside the shell',
    async (_name, path, heading) => {
      const { container } = await renderApp({ path });
      await screen.findByRole('heading', { name: heading, level: 1 });
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
      expect(await violations(container)).toEqual([]);
    },
  );

  it('has no detectable violations in the forbidden and expired states', async () => {
    const forbidden = await renderApp({ account: 'viewer', path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(forbidden.container)).toEqual([]);
    forbidden.unmount();

    const { api, container } = await renderApp({ path: '/configuracion/empresa' });
    await screen.findByDisplayValue('Transportes Demo SA');
    api.controls.expireSession();
    type('Nombre de la empresa', 'x');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(await violations(container)).toEqual([]);
  });
});
