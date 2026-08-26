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
    // tools/oxlint is the repo's OWN oxlint anti-slop plugin (custom AST rules,
    // never bundled by the app). react-doctor's bundled `anti-slop` plugin flags
    // the very source that implements those rules — e.g. `anti-slop(no-runtime-
    // typeof)` firing on `rules/no-runtime-typeof.ts`, and the `unknown`
    // parameters + runtime `typeof` guards every AST node-type check must use.
    // test-support/ is jsdom/seed infrastructure (setup-dom.ts reads `window` at
    // module scope, which only ever runs in the test env — never SSR — so the
    // no-unguarded-browser-global premise doesn't hold). planning/ is 800+ design
    // and discovery documents, not app source.
    files: [
      "**/design/**",
      "**/.claude/**",
      "**/data/**",
      "**/*.server.test.ts",
      "**/tools/oxlint/**",
      "**/test-support/**",
      "**/planning/**",
    ],
  },
};
