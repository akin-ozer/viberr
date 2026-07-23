// react-doctor runs via npx (not a dependency), so no typed import here.
export default {
  ignore: {
    // .claude/worktrees and data/ (the gitignored VIBERR_DATA_ROOT) both hold
    // live agent checkouts of this same repo — scanning them double-counts
    // every finding against stale copies. design/ is the standalone mockup
    // bundle (static HTML/JSX prototypes, never bundled by the app) — its
    // support.js is what produced 45 phantom postmessage-origin-risk hits.
    // *.server.test.ts files are server-only test fixtures (react-router never
    // bundles .server. modules client-side) — their synthetic PATs aren't
    // "client code" secrets.
    files: [
      "**/design/**",
      "**/.claude/**",
      "**/data/**",
      "**/*.server.test.ts",
    ],
  },
};
