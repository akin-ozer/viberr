import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAppError } from "~/server/errors/app-error.server";
import {
  isSecretBox,
  openSecret,
  openSecretRotating,
  previousSecretKeys,
  sealSecret,
} from "./secret-box.server";

const key = randomBytes(32);

function expectSecretBoxError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected a secret_box_invalid AppError");
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("secret_box_invalid");
      // Never leak plaintext or key material through messages.
      expect(error.message).not.toContain("github_pat_");
      expect(error.userMessage).toBe("A stored secret could not be read.");
    }
  }
}

describe("secret-box", () => {
  it("round-trips plaintext (incl. unicode)", () => {
    for (const secret of [
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "",
      "şifre-çok-gizli-🤫",
    ]) {
      const box = sealSecret(secret, key);
      expect(openSecret(box, key)).toBe(secret);
    }
  });

  it("produces the v1$iv$ct$tag format with fresh ivs per seal", () => {
    const a = sealSecret("same plaintext", key);
    const b = sealSecret("same plaintext", key);
    expect(isSecretBox(a)).toBe(true);
    expect(a.split("$")).toHaveLength(4);
    expect(a.split("$")[0]).toBe("v1");
    expect(a).not.toBe(b); // random iv → different box every time
    expect(a.split("$")[1]).not.toBe(b.split("$")[1]);
  });

  it("rejects tampered ciphertext, tag and iv", () => {
    const box = sealSecret("github_pat_TAMPER_ME", key);
    const [v, iv, ct, tag] = box.split("$") as [string, string, string, string];

    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64");
    };

    expectSecretBoxError(() => openSecret([v, iv, flip(ct), tag].join("$"), key));
    expectSecretBoxError(() => openSecret([v, iv, ct, flip(tag)].join("$"), key));
    expectSecretBoxError(() => openSecret([v, flip(iv), ct, tag].join("$"), key));
  });

  it("rejects the wrong key", () => {
    const box = sealSecret("secret", key);
    expectSecretBoxError(() => openSecret(box, randomBytes(32)));
  });

  it("rejects malformed boxes and unknown versions", () => {
    expectSecretBoxError(() => openSecret("not-a-box", key));
    expectSecretBoxError(() => openSecret("v1$only$three", key));
    const box = sealSecret("secret", key);
    expectSecretBoxError(() =>
      openSecret(box.replace(/^v1\$/, "v9$"), key),
    );
  });

  it("isSecretBox is a cheap format check", () => {
    expect(isSecretBox(sealSecret("x", key))).toBe(true);
    expect(isSecretBox("github_pat_plaintext")).toBe(false);
    expect(isSecretBox("v2$a$b$c")).toBe(false);
  });
});

/**
 * A9/pass-16 — key rotation was UNIMPLEMENTED. Changing
 * `VIBERR_SECRET_ENCRYPTION_KEY` bricked every stored PAT (a 500 at the next
 * GitHub call) and silently downgraded every authenticated MCP server to
 * anonymous. Rotation is now a real, lazy, no-migration operation.
 */
describe("secret-box key rotation (A9)", () => {
  it("opens a box sealed under a RETIRED key and flags it for re-sealing", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const box = sealSecret("tok_live_123", oldKey);

    // The current key alone cannot read it — that was the whole failure.
    expectSecretBoxError(() => openSecret(box, newKey));

    const opened = openSecretRotating(box, newKey, [oldKey]);
    expect(opened.plaintext).toBe("tok_live_123");
    expect(opened.staleKey).toBe(true);
  });

  it("a box under the CURRENT key never reports a stale key (no needless rewrite)", () => {
    const newKey = randomBytes(32);
    const opened = openSecretRotating(sealSecret("x", newKey), newKey, [
      randomBytes(32),
    ]);
    expect(opened).toEqual({ plaintext: "x", staleKey: false });
  });

  it("tries EVERY retired key, and still throws when none of them opens it", () => {
    const wanted = randomBytes(32);
    const box = sealSecret("x", wanted);
    expect(
      openSecretRotating(box, randomBytes(32), [randomBytes(32), wanted])
        .plaintext,
    ).toBe("x");
    expectSecretBoxError(() =>
      openSecretRotating(box, randomBytes(32), [randomBytes(32)]),
    );
  });

  it("parses the retired-key env list and drops unusable entries in silence", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(
      previousSecretKeys({
        VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS: `${a.toString("base64")}, ${b.toString("base64")}`,
      } as NodeJS.ProcessEnv).map((k) => k.toString("base64")),
    ).toEqual([a.toString("base64"), b.toString("base64")]);
    // Wrong-length / empty entries are skipped rather than thrown about — an
    // error message must never hint at key material.
    expect(
      previousSecretKeys({
        VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS: `,${Buffer.alloc(8).toString("base64")},`,
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
    expect(previousSecretKeys({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
