import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

interface StorybookEntry {
  id: string;
  type: string;
}

// The story list comes from the built Storybook index, so a new story gets a snapshot requirement
// automatically (a missing baseline fails the check instead of being silently skipped).
const index = JSON.parse(
  readFileSync(resolve(__dirname, '../../packages/ui/storybook-static/index.json'), 'utf8'),
) as { entries: Record<string, StorybookEntry> };
const stories = Object.values(index.entries)
  .filter((entry) => entry.type === 'story')
  .map((entry) => entry.id)
  .sort();

test('the Storybook index lists stories', () => {
  expect(stories.length).toBeGreaterThanOrEqual(17);
});

for (const id of stories) {
  test(`story ${id} matches its pixel baseline`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);
    await expect(page.locator('#storybook-root > *').first()).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/sb-show-errordisplay/);
    const fonts = await page.evaluate(async () => {
      const faces = [
        '400 14px "IBM Plex Sans"',
        '600 14px "IBM Plex Sans"',
        '400 14px "IBM Plex Mono"',
      ];
      const loaded = await Promise.all(faces.map((face) => document.fonts.load(face)));
      await document.fonts.ready;
      return loaded.map((list, index) => ({
        face: faces[index],
        count: list.length,
        statuses: list.map((font) => font.status),
      }));
    });
    for (const { face, count, statuses } of fonts) {
      expect(count, `${face} matches a bundled font face`).toBeGreaterThan(0);
      expect(statuses, `${face} is loaded`).not.toContain('error');
      expect(
        statuses.every((status) => status === 'loaded'),
        `${face} is loaded`,
      ).toBe(true);
    }
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await expect(page).toHaveScreenshot(`${id}.png`, { fullPage: true });
  });
}
