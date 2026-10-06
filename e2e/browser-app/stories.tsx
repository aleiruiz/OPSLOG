// Minimal CSF renderer: mounts every packages/ui `*.stories.tsx` story without a Storybook runtime so
// Playwright can scan them with axe. Stories stay plain Storybook CSF and keep working there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, Typography } from '@mui/material';
import { opslogTheme } from '@opslog/ui';

type StoryArgs = Record<string, unknown>;
interface StoryDefinition {
  args?: StoryArgs;
  parameters?: { harness?: string };
  render?: (args: StoryArgs) => React.ReactNode;
}
interface StoryMeta {
  title?: string;
  component?: React.ComponentType<StoryArgs>;
  args?: StoryArgs;
  parameters?: { harness?: string };
  render?: (args: StoryArgs) => React.ReactNode;
}
type StoryModule = { default: StoryMeta } & Record<string, unknown>;

const modules = (
  import.meta as unknown as {
    glob: (patterns: string[], options: { eager: true }) => Record<string, StoryModule>;
  }
).glob(
  [
    '../../packages/ui/src/**/*.stories.tsx',
    '../../apps/web/vehicles/**/*.stories.tsx',
    '../../apps/web/areas/**/*.stories.tsx',
    '../../apps/web/documents/**/*.stories.tsx',
    '../../apps/web/insurance/**/*.stories.tsx',
  ],
  { eager: true },
);

// Stories that open a modal hide the rest of the page (by design), so the all-stories axe page skips them; the
// dialog is scanned on its own in e2e/vehicles.spec.ts.
const isModal = (meta: StoryMeta, story: StoryDefinition) =>
  (story.parameters?.harness ?? meta.parameters?.harness) === 'modal';

function StoryView({ meta, story }: { meta: StoryMeta; story: StoryDefinition }) {
  const args = { ...meta.args, ...story.args };
  const render = story.render ?? meta.render;
  if (render) return <>{render(args)}</>;
  const Component = meta.component;
  return Component ? <Component {...args} /> : null;
}

function Stories() {
  return (
    <main>
      <Typography component="h1" variant="h1">
        Stories OPSLOG
      </Typography>
      {Object.entries(modules).flatMap(([path, module]) =>
        Object.entries(module)
          .filter(
            ([name, story]) =>
              name !== 'default' && !isModal(module.default, story as StoryDefinition),
          )
          .map(([name, story]) => (
            <section
              key={`${path}:${name}`}
              aria-label={`${module.default.title ?? path} / ${name}`}
            >
              <Typography component="h2" variant="h2">
                {module.default.title ?? path} / {name}
              </Typography>
              <StoryView meta={module.default} story={story as StoryDefinition} />
            </section>
          )),
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      <Stories />
    </ThemeProvider>
  </React.StrictMode>,
);
