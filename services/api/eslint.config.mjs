import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const legacyConfig = require('../../.eslintrc.base.cjs');
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: [
      'node_modules/**', 'dist/**', '.next/**', 'coverage/**', '**/*.d.ts',
      'build/**', '.cache/**', '.turbo/**', '.vercel/**', 'generated/**',
      'prisma/generated/**',
    ],
  },
  ...compat.config(legacyConfig),
];
