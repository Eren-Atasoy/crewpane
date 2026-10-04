// ESLint flat config — Phase 0 baseline.
//
// Rules start at "warn" so the existing codebase is not blocked; each refactor phase
// tightens them (see refactor feedback doc §4). `no-empty` with allowEmptyCatch:false
// surfaces the ~170 silent catches that Phase 5 must annotate or log.
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'standalone/**',
      'mobile-web/**',
      'app.asar.unpacked/**',
      'logs/**',
      'scratch/**',
      'dist/**',
      'demo-site/**',
      '.crewpane/**',
      '.claude/**',
      '.gemini/**',
      '.qwen/**',
    ],
  },
  js.configs.recommended,
  {
    // Existing code carries disable-comments for rules from an older lint setup
    // (global-require, no-await-in-loop…); don't report them as "unused".
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
