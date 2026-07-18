// react-doctor runs via npx (not a dependency), so no typed import here.
export default {
  ignore: {
    // .claude/worktrees holds live agent checkouts of this same repo —
    // scanning them double-counts every finding. *.server.test.ts files are
    // server-only test fixtures (react-router never bundles .server. modules
    // client-side) — their synthetic PATs aren't "client code" secrets.
    files: ["**/design/**", "**/.claude/**", "**/*.server.test.ts"],
  },
};
