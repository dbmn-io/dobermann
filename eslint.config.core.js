/**
 * Issue #326: the core boundary. Modules listed in scripts/core-modules.json are environment-blind:
 * they never import VS Code (not even types), never speak Supabase (#417: the adapters are in
 * src/platform/supabase) and never read host services off `global` — they get them injected
 * through ports (Architecture.md → Testing Strategy → Core lane).
 *
 * `npm run lint:core` runs this on its own (pre-commit); eslint.config.architecture.js includes it.
 */
const tsParser = require('@typescript-eslint/parser');
const { modules } = require('./scripts/core-modules.json');

module.exports = [
  {
    files: modules.map(m => `src/${m}.ts`),
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'vscode', message: 'Core never imports VS Code — take the host service as an injected dependency (#326).' },
          { name: '@supabase/supabase-js', message: 'Core never speaks Supabase — the adapters live in src/platform/supabase and are injected behind a port (#417).' }
        ],
        patterns: [
          { group: ['**/platform/supabase/*'], message: 'Core never imports a Supabase adapter — depend on the port and let the host inject src/platform/supabase (#417).' }
        ]
      }],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value='vscode']",
          message: 'Core never requires VS Code — take the host service as an injected dependency (#326).'
        },
        {
          selector: "TSAsExpression[expression.type='Identifier'][expression.name='global']",
          message: 'Core never reads host services off `global` — inject them (#321, #326).'
        },
        {
          selector: "MemberExpression[object.type='Identifier'][object.name='global']",
          message: 'Core never reads host services off `global` — inject them (#321, #326).'
        }
      ]
    }
  }
];
