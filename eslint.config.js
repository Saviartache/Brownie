// Flat ESLint config. Rules earn their place by catching a class of bug we have
// actually shipped; stylistic questions belong to Prettier, not to the linter.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.venv` alongside `node_modules`: a Python virtual environment ships
    // vendored JavaScript inside `site-packages`, and linting somebody else's
    // `WScript` shim says nothing about this project.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.venv/**',
      '**/*.d.ts',
      'apps/native/**',
      // Other people's source, kept to be read rather than built. See
      // `.gitignore`.
      'references/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Escape hatches that hide, rather than fix, a type error.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
      ],

      // Async correctness — an unawaited promise in a packet handler is a bug
      // that only shows up as a silent unhandled rejection.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Import hygiene under verbatimModuleSyntax.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-param-reassign': 'error',

      // Unused arguments are usually a signature we forgot to trim; a leading
      // underscore is the explicit "this one is required by the interface".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests reach into internals and build deliberately malformed input.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // `expect(() => thing.mutate()).toThrow()` is the idiomatic way to assert
      // on a void call; wrapping every one in braces buys nothing.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // Config files and build scripts are plain JS and have no type information
    // to lint against. They are Node programs, so `process` and friends are
    // globals rather than undefined names.
    // The spread comes first: it carries a `languageOptions` of its own, and
    // ours has to win rather than be replaced by it.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
