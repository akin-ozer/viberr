import { resetEnvCacheForTests } from "~/server/config/env.server";

/**
 * Runs `run` with `vars` set in the process env, where a deployment sets them,
 * and puts each one back afterwards. Ruling 8: a test reaches a switch the
 * way production does, not through a parameter only it passes. `getEnv()`
 * parses the env once per process, so the cached parse is dropped on the way in
 * and on the way out.
 */
export async function withEnv<T>(
  vars: Readonly<Record<string, string>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  resetEnvCacheForTests();
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  }
}
