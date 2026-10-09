import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../../../test-support/env";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { errorMessage } from "../../shared/errors";
import { getEnv, parseEnv } from "./env.server";
import {
  createInstanceSecrets,
  instanceSecretsPath,
  readInstanceSecrets,
  withInstanceSecrets,
} from "./instance-secrets.server";

/**
 * Ruling 38: a starter's `docker compose up` needs no `.env`, so the two
 * secrets the app cannot run without are generated into the data root when the
 * environment leaves them unset, and every process reads the same ones back.
 */

const temp = createTempDirs();
afterEach(temp.cleanup);

function thrownBy(run: () => void): string {
  try {
    run();
  } catch (error) {
    return errorMessage(error);
  }
  return "";
}

describe("generated instance secrets (ruling 38)", () => {
  it("generates both once, for the server only, and every later reader gets the same ones", () => {
    const dataRoot = temp.make("viberr-secrets-");
    const first = withInstanceSecrets({}, dataRoot);
    const file = instanceSecretsPath(dataRoot);

    // What boot parses: a session secret and a 32-byte key.
    expect(parseEnv(first).VIBERR_SECRET_ENCRYPTION_KEY.byteLength).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual(["instance-secrets.json"]);

    const again = withInstanceSecrets({ VIBERR_DATA_ROOT: dataRoot }, "./not-this-root");
    expect(again.VIBERR_SESSION_SECRET).toBe(first.VIBERR_SESSION_SECRET);
    expect(again.VIBERR_SECRET_ENCRYPTION_KEY).toBe(first.VIBERR_SECRET_ENCRYPTION_KEY);
  });

  it("takes each value the environment sets over the file, and touches nothing when it sets both", () => {
    const dataRoot = temp.make("viberr-secrets-");
    const session = "a-session-secret-the-operator-chose-0123456789";
    const both = {
      VIBERR_DATA_ROOT: dataRoot,
      VIBERR_SESSION_SECRET: session,
      VIBERR_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    };
    expect(withInstanceSecrets(both, dataRoot)).toBe(both);
    expect(existsSync(instanceSecretsPath(dataRoot))).toBe(false);

    // Empty counts as unset, as it does for parseEnv.
    const filled = withInstanceSecrets({ ...both, VIBERR_SECRET_ENCRYPTION_KEY: "" }, dataRoot);
    expect(filled.VIBERR_SESSION_SECRET).toBe(session);
    expect(filled.VIBERR_SECRET_ENCRYPTION_KEY).toBe(
      readInstanceSecrets(dataRoot)?.VIBERR_SECRET_ENCRYPTION_KEY,
    );
  });

  it("adopts the file another process linked first instead of replacing it", () => {
    const dataRoot = temp.make("viberr-secrets-");
    const winner = createInstanceSecrets(dataRoot);
    // A second first boot on the same root: its link finds the name taken.
    // CANARY: rename the staging file into place and this one wins instead,
    // with a key nothing was sealed under.
    expect(createInstanceSecrets(dataRoot)).toEqual(winner);
    expect(readdirSync(path.join(dataRoot, "state"))).toEqual(["instance-secrets.json"]);
  });

  it("stops on a file it cannot read instead of generating a key over it, and never quotes it", () => {
    const dataRoot = temp.make("viberr-secrets-");
    mkdirSync(path.join(dataRoot, "state"));
    const file = instanceSecretsPath(dataRoot);
    writeFileSync(file, '{"VIBERR_SESSION_SECRET": "cut off mid-wri');

    const message = thrownBy(() => withInstanceSecrets({}, dataRoot));
    expect(message).toContain(file);
    expect(message).toContain("never regenerated");
    expect(message).not.toContain("cut off");
    expect(readFileSync(file, "utf8")).toContain("cut off");
  });

  it("is what getEnv() hands the whole process when the environment sets neither", async () => {
    const dataRoot = temp.make("viberr-secrets-");
    await withEnv(
      { VIBERR_DATA_ROOT: dataRoot, VIBERR_SESSION_SECRET: "", VIBERR_SECRET_ENCRYPTION_KEY: "" },
      () => {
        const env = getEnv();
        const generated = readInstanceSecrets(dataRoot);
        expect(generated).not.toBeNull();
        expect(env.VIBERR_SESSION_SECRET).toBe(generated?.VIBERR_SESSION_SECRET);
        expect(env.VIBERR_SECRET_ENCRYPTION_KEY.toString("base64")).toBe(
          generated?.VIBERR_SECRET_ENCRYPTION_KEY,
        );
      },
    );
  });
});
