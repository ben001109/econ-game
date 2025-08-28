module.exports = {
  extends: ['next/core-web-vitals', '../../.eslintrc.base.cjs'],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.json'],
  },
  rules: {
    // Next.js apps may use console for debugging; keep warnings only
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};

