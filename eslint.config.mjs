import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    // FND-INTEGRATE registers packages/ui with its own TypeScript project.
    ignores: ['**/dist/**', '**/coverage/**', 'pnpm-lock.yaml', 'packages/ui/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { project: true } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
];
