import { commitTypes } from "./release.config.ts";

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", commitTypes.map((t) => t.type)],
    // Bodies are written with semantic line breaks and wrapped at 100 columns.
    "body-max-line-length": [2, "always", 100],
  },
};
