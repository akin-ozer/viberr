import { parseEnv } from "node:util";

/** `compose.yml`'s `${PORT:-3000}` default, which is also the image's `ENV PORT`. */
export const COMPOSE_DEFAULT_PORT = "3000";

/**
 * The host port `compose.yml` publishes the app on, resolved the way compose
 * interpolates `${PORT:-3000}`: a `PORT` in the invoking shell wins, even an
 * empty one; otherwise the project's `.env`; and an unset or empty value falls
 * back to the default. `util.parseEnv` reads `.env` the way compose does for
 * every form a port takes — quoted, `export`-prefixed, trailing `# comment`,
 * last-assignment-wins — checked against `docker compose config`.
 *
 * `npm run deploy` polls this port after `up -d`. It was hard-coded to 5173,
 * so on a default setup (no `PORT` in `.env`, container on 3000) the verify
 * step waited three minutes on a port nothing listened on and failed a deploy
 * that had worked.
 */
export function composePort(
  shellEnv: Record<string, string | undefined>,
  dotenv: string | null,
): string {
  const value = shellEnv.PORT ?? (dotenv === null ? undefined : parseEnv(dotenv).PORT);
  return value || COMPOSE_DEFAULT_PORT;
}
