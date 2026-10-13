import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/storybook-static/**', 'pnpm-lock.yaml'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser, parserOptions: { project: true } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Convención de tamaño: archivos de producción con una sola responsabilidad, máx. ~400 líneas.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.stories.tsx',
      '**/test-support/**',
      'e2e/**',
      'tests/**',
    ],
    rules: { 'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }] },
  },
  {
    // Archivos heredados por encima del límite; se dividen cuando se tocan. La lista solo se reduce.
    files: ['packages/contracts/src/client.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // The real-API browser harness pulls in the whole server composition; parsing it with the
    // e2e type program exhausts CI memory. It is type-checked by tsc (e2e/real-api/tsconfig.json),
    // and no lint rule here needs type information.
    files: ['e2e/real-api/**/*.ts', 'e2e/maintenance-real.spec.ts'],
    languageOptions: { parserOptions: { project: false } },
  },
  prettier,
];
