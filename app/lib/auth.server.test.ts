import { describe, expect, it } from "vitest";
import {
  canonicalLoopbackRedirectUrl,
  trustedAuthOrigins,
} from "./auth.server";

describe("trustedAuthOrigins", () => {
  it("trusts only the canonical origin so OAuth state stays on one host", () => {
    expect(trustedAuthOrigins("http://localhost:5173")).toEqual([
      "http://localhost:5173",
    ]);
    expect(trustedAuthOrigins("http://127.0.0.1:3000")).toEqual([
      "http://127.0.0.1:3000",
    ]);
  });

  it("keeps non-local production origins exact", () => {
    expect(trustedAuthOrigins("https://viberr.example.com")).toEqual([
      "https://viberr.example.com",
    ]);
    expect(trustedAuthOrigins(undefined)).toEqual([]);
  });

  it("canonicalizes only alternate local loopback page URLs", () => {
    expect(
      canonicalLoopbackRedirectUrl(
        "http://127.0.0.1:5173/projects/viberr?tab=review",
        "http://localhost:5173",
      ),
    ).toBe("http://localhost:5173/projects/viberr?tab=review");
    expect(
      canonicalLoopbackRedirectUrl(
        "http://localhost:5173/projects/viberr",
        "http://localhost:5173",
      ),
    ).toBeNull();
    expect(
      canonicalLoopbackRedirectUrl(
        "https://viberr.example.com/projects/viberr",
        "https://viberr.example.com",
      ),
    ).toBeNull();
  });
});
