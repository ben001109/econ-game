module.exports = {
  extends: ['../../.eslintrc.base.cjs'],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.json'],
  },
};

