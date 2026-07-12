// react-doctor runs via npx (not a dependency), so no typed import here.
export default {
  ignore: {
    // .claude/worktrees holds live agent checkouts of this same repo —
    // scanning them double-counts every finding.
    files: ["**/design/**", "**/.claude/**"],
  },
};
