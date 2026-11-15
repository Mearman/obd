import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
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
    // core runs unchanged in Node and in the browser, so it may use neither platform's modules.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "net", "path", "os", "child_process", "buffer", "stream"],
              message:
                "core is platform-free: import platform code from an entry point, not from core.",
            },
            {
              group: ["**/node/**", "**/web/**"],
              message: "core never imports a platform entry point; platforms register into core.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "navigator",
          "localStorage",
          "indexedDB",
          "Buffer",
          "process",
        ].map((name) => ({ name, message: "core is platform-free." })),
      ],
    },
  },
  {
    // the browser entry point may use DOM globals but no Node module, so it runs in a page.
    files: ["src/web/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "net", "path", "os", "child_process", "buffer", "stream"],
              message: "the browser entry point cannot import Node modules.",
            },
            {
              group: ["**/node/**"],
              message: "the browser entry point never imports the Node entry point.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["Buffer", "process"].map((name) => ({
          name,
          message: "the browser entry point cannot use Node globals.",
        })),
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
