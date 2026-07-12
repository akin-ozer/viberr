import { describe, expect, it } from "vitest";
import {
  oauthLoginErrorCallback,
  oauthLoginErrorMessage,
} from "./oauth-login-error";

describe("oauthLoginErrorMessage", () => {
  it("turns whitelist rejection into truthful login-page copy", () => {
    expect(oauthLoginErrorMessage("unable_to_create_user")).toContain(
      "isn't whitelisted",
    );
    expect(oauthLoginErrorMessage("signup disabled")).toContain(
      "isn't whitelisted",
    );
  });

  it("distinguishes cancellation and safely generalizes unknown provider errors", () => {
    expect(oauthLoginErrorMessage("access_denied")).toContain("canceled");
    expect(oauthLoginErrorMessage("invalid_code")).toBe(
      "OAuth sign-in couldn't be completed. Try again, or use a local account.",
    );
    expect(oauthLoginErrorMessage(null)).toBeNull();
  });

  it("returns OAuth errors to login without dropping the intended destination", () => {
    expect(oauthLoginErrorCallback(null)).toBe("/login");
    expect(oauthLoginErrorCallback("/projects/viberr-core/board?mine=1")).toBe(
      "/login?returnTo=%2Fprojects%2Fviberr-core%2Fboard%3Fmine%3D1",
    );
  });
});
