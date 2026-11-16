/**
 * ESLint flat config to prevent architectural drift
 * Catches anti-patterns at development time
 * Updated for ESLint 9+ flat config format
 */

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  // Issue #326: the core boundary (also run alone by `npm run lint:core`)
  ...require('./eslint.config.core.js'),
  {
    // UI Services: No database calls allowed
    files: [
      'src/services/status-bar/**/*.ts',
      'src/services/button-state/**/*.ts',
      'src/services/tree-panel/**/*.ts'
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AwaitExpression > CallExpression[callee.property.name=/^get.*Execution/]',
          message: 'UI services cannot make database calls (Issue #45 prevention)'
        },
        {
          selector: 'CallExpression[callee.property.name="getExecutionsByBatch"]',
          message: 'Direct database queries forbidden in UI services - use pre-calculated data'
        },
        {
          selector: 'MethodDefinition[key.name="getBatchTooltip"][value.async=true]',
          message: 'UI formatting methods must be synchronous to prevent Issue #44 hangs'
        }
      ],
      'prefer-const': 'error'
    }
  },
  {
    // Webviews: No business logic allowed
    files: ['src/webviews/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ClassDeclaration[id.name=/Service$/]',
          message: 'Business logic services not allowed in webviews - use backend services'
        },
        {
          selector: 'CallExpression[callee.name="fetch"]',
          message: 'Direct HTTP calls not allowed in webviews - use message passing'
        }
        // #442: no AwaitExpression rule. It predates the Hub's tabs, and DbmnModal's
        // `onSubmit: async` (CLAUDE.md → DBMN-Native UX) is the recommended pattern.
      ]
    }
  },
  {
    // Service files: Enforce isolation patterns (simplified rules)
    files: ['src/services/**/*.service.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TryStatement > BlockStatement > ExpressionStatement:has(CallExpression[callee.property.name="resolve"]) ~ ExpressionStatement:has(CallExpression[callee.property.name="resolve"])',
          message: 'Bulk service resolution risks cascade failures - resolve services individually'
        },
        {
          selector: 'AssignmentExpression[left.type="MemberExpression"][left.object.type="TSAsExpression"][left.object.expression.name="global"][left.object.typeAnnotation.type="TSAnyKeyword"]',
          message: 'Use LoggerRegistry instead of (global as any) for professional logger access'
        },
        {
          selector: 'MemberExpression[object.type="TSAsExpression"][object.expression.name="global"][object.typeAnnotation.type="TSAnyKeyword"][property.name=/^dbmn.*Logger$/]',
          message: 'Use LoggerRegistry.getDiagnosticLogger() or LoggerRegistry.getExecutionLogger() instead of (global as any)'
        }
      ],
      // #442: console.* in a service is a warning, not an error. Portable services (core, web,
      // desktop) have no VS Code output channel, so console is their log; the VS Code-only ones
      // (sign-in, telemetry) can move to the diagnostic logger one day. The warnings keep count.
      'no-console': ['warn', { allow: ['debug', 'trace', 'dir', 'table', 'time', 'timeEnd', 'group', 'groupEnd', 'groupCollapsed', 'assert', 'count'] }],
      'prefer-const': 'error'
    }
  },
  {
    // Integration test files: Enforce real implementations over mocks
    files: ['src/test/integration/**/*.test.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['sinon', '@types/sinon'],
              importNames: ['stub', 'spy', 'mock'],
              message: 'Prefer real implementations over mocks in integration tests'
            }
          ]
        }
      ]
    }
  }
];