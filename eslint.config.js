import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "dist-app/", "dist-desktop/", "coverage/", "test-results/", "playwright-report/", "release/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },
  {
    // Node scripts: console/process/Buffer are the whole point.
    files: ["scripts/**/*.mjs", "*.config.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    // Browser-driving gates: page.evaluate() bodies are serialised and run
    // inside the app's renderer, so DOM globals are correct there.
    files: ["scripts/verify-arena-entry.mjs"],
    languageOptions: {
      globals: { document: "readonly", getComputedStyle: "readonly" },
    },
  },
);
