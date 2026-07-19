import { pathToFileURL } from "node:url";

const REQUIRED_ENV_VARS = [
  "VIBERR_SESSION_SECRET",
  "VIBERR_SECRET_ENCRYPTION_KEY",
] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export interface EnvCheckResult {
  missing: RequiredEnvVar[];
  exitCode: 0 | 1;
  stdout?: string;
  stderr?: string;
}

/** Validates only that the boot-critical secrets are present and non-empty. */
export function checkEnv(
  env: Record<string, string | undefined>,
): EnvCheckResult {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]?.trim());

  if (missing.length > 0) {
    return {
      missing,
      exitCode: 1,
      stderr: `Missing required environment variable(s): ${missing.join(", ")}`,
    };
  }

  return { missing, exitCode: 0, stdout: "env ok" };
}

function main(): void {
  const result = checkEnv(process.env);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
