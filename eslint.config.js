'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', '.vscode-test/**', '.sandbox/**', 'dist/**', 'patches/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: { ...globals.node, ...globals.browser, acquireVsCodeApi: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-mixed-operators': ['error', { groups: [['&&', '||']] }],
    },
  },
];
