/**
 * The seed's bootstrap-admin password, in a module with NO imports.
 *
 * It lives here rather than in `seed.server.ts` because non-Vite consumers read
 * it too: `e2e/auth.setup.ts` signs the e2e admin in with the same value so
 * the two can never drift. `seed.server.ts` transitively imports the shipped
 * agent assets through Vite's `?raw` (`default-assets.server.ts`), and
 * Playwright's Babel transform has no `?raw` loader — when the constant lived
 * there, it tried to parse `viberr-app-expertise.skill.md` as JavaScript and
 * the whole e2e suite failed to load its config. Keeping the constant
 * import-free makes that impossible.
 */
export const SEED_DEFAULT_PASSWORD = "viberr-dev-2828";
