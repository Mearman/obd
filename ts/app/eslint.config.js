import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "screenshots/",
      "test-results/",
      "playwright-report/",
      "dev-dist/",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // The application never fetches at run time: everything ships in the precached bundle.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "the app makes no runtime network requests." },
        { name: "XMLHttpRequest", message: "the app makes no runtime network requests." },
        { name: "WebSocket", message: "the app makes no runtime network requests." },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
