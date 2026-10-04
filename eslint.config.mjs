import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/**', '**/coverage/**', 'pnpm-lock.yaml'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser, parserOptions: { project: true } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
];
