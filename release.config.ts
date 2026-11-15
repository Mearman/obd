import type { Options } from "semantic-release";

type ReleaseLevel = "major" | "minor" | "patch" | false;

interface CommitType {
  readonly type: string;
  readonly release: ReleaseLevel;
}

/**
 * The conventional-commit types this project uses and what each releases. commitlint's allowed types (commitlint.config.ts imports this) and commit-analyzer's rules both derive from it, so a type cannot release without being accepted by commit validation, or the reverse. Only changes a user of the app or the package can notice release; documentation, tests, formatting, refactors, build and CI changes do not.
 */
export const commitTypes: readonly CommitType[] = [
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "revert", release: "patch" },
  { type: "refactor", release: false },
  { type: "docs", release: false },
  { type: "style", release: false },
  { type: "test", release: false },
  { type: "build", release: false },
  { type: "ci", release: false },
  { type: "chore", release: false },
];

/**
 * Runs on `main`. Reads the commits since the last tag, picks the next version, tags the commit and creates the GitHub Release with generated notes. It commits nothing back and publishes to no registry: the version lives only in the tag, and the package.json versions are placeholders.
 */
const config: Options = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { breaking: true, release: "major" },
          ...commitTypes.map((t) => ({ type: t.type, release: t.release })),
        ],
      },
    ],
    // Angular, not conventionalcommits: the conventionalcommits preset needs conventional-changelog-writer 9, and the notes generator semantic-release bundles loads version 8, which fails on its template.
    ["@semantic-release/release-notes-generator", { preset: "angular" }],
    "@semantic-release/github",
    // The Pages build reads the latest tag for the version it shows, and a tag made with the workflow's own token starts no workflow, so a release asks for the rebuild itself.
    ["@semantic-release/exec", { publishCmd: "gh workflow run pages.yml --ref main" }],
  ],
};

export default config;
