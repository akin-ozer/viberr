import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Ruling 38: a starter's `docker compose up` needs no `.env`.
 *
 * The two secrets the app cannot run without, VIBERR_SESSION_SECRET and
 * VIBERR_SECRET_ENCRYPTION_KEY, are generated when the environment leaves them
 * unset: once, by the first process that reads the env, into
 * `<data root>/state/instance-secrets.json`. Every process after it (the
 * server, the seed, the backup, the key tools) reads the same file, so they all
 * sign and seal with the same keys. A value the environment sets wins, key by
 * key, and an environment that sets both reads and writes nothing here.
 *
 * The file is the server's: 0600, inside the `state/` that boot holds at 0700
 * (`enforceStoreLayout`), so no agent uid can open it (ruling 15). A backup
 * carries it (`backup.server.ts`). It is never regenerated: a file that cannot
 * be read stops the process, because a new key would leave every secret sealed
 * under the old one unreadable.
 */

export const INSTANCE_SECRETS_FILE = "instance-secrets.json";

const GENERATED_KEYS = [
  "VIBERR_SESSION_SECRET",
  "VIBERR_SECRET_ENCRYPTION_KEY",
] as const;

const instanceSecretsSchema = z.object({
  VIBERR_SESSION_SECRET: z.string().min(32),
  VIBERR_SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").byteLength === 32),
  createdAt: z.string(),
});

export type InstanceSecrets = z.infer<typeof instanceSecretsSchema>;

const fileMissing = z.object({ code: z.literal("ENOENT") });
const fileExists = z.object({ code: z.literal("EEXIST") });
const errnoCode = z.object({ code: z.string() });

export function instanceSecretsPath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), "state", INSTANCE_SECRETS_FILE);
}

/** Never echoes the file's content: a parse error quotes the text it failed on. */
function unreadable(file: string, why: string): Error {
  return new Error(
    `${file} holds the VIBERR_SESSION_SECRET and VIBERR_SECRET_ENCRYPTION_KEY this ` +
      `instance generated for itself (ruling 38), and it ${why}. It is never ` +
      "regenerated, because a new key would leave every sealed secret unreadable: " +
      "restore it from a backup, or set both variables in the environment.",
  );
}

/** The secrets generated under `dataRoot`, or null when none have been. */
export function readInstanceSecrets(dataRoot: string): InstanceSecrets | null {
  const file = instanceSecretsPath(dataRoot);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (fileMissing.safeParse(error).success) return null;
    const code = errnoCode.safeParse(error);
    throw unreadable(file, `cannot be read (${code.success ? code.data.code : "unknown error"})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw unreadable(file, "is not valid JSON");
  }
  const parsed = instanceSecretsSchema.safeParse(json);
  if (!parsed.success) throw unreadable(file, "does not hold both secrets");
  return parsed.data;
}

/**
 * Generates the secrets under `dataRoot`, or returns the ones another process
 * generated first. The file is written whole under a temporary name and then
 * linked into place: a link fails when the name exists, so two first processes
 * cannot both win, and no reader ever sees half a file.
 */
export function createInstanceSecrets(dataRoot: string): InstanceSecrets {
  const file = instanceSecretsPath(dataRoot);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secrets: InstanceSecrets = {
    VIBERR_SESSION_SECRET: randomBytes(48).toString("base64"),
    VIBERR_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  const staging = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(staging, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(secrets, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(staging, file);
    return secrets;
  } catch (error) {
    if (!fileExists.safeParse(error).success) throw error;
    // Another process linked its file first: its keys are this instance's.
    const winner = readInstanceSecrets(dataRoot);
    if (!winner) throw error;
    return winner;
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * The raw environment with each secret it leaves unset (missing or empty, as
 * `parseEnv` reads it) taken from the data root's generated file, which the
 * first caller creates. `getEnv()` parses this, so the server and every CLI
 * resolve the same way.
 */
export function withInstanceSecrets(
  raw: Record<string, string | undefined>,
  defaultDataRoot: string,
) {
  const unset = GENERATED_KEYS.filter((key) => !raw[key]);
  if (unset.length === 0) return raw;
  const dataRoot = raw.VIBERR_DATA_ROOT || defaultDataRoot;
  const secrets = readInstanceSecrets(dataRoot) ?? createInstanceSecrets(dataRoot);
  return { ...raw, ...Object.fromEntries(unset.map((key) => [key, secrets[key]])) };
}
