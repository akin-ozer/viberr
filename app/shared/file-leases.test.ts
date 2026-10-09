import { describe, expect, it } from "vitest";
import { globsOverlap, leaseConflictFor, leaseRefusal, matchesGlob, type FileLease } from "./file-leases";

/**
 * Ruling 60 (pass 37, F37-74). A lease decides whether a delivery is refused,
 * so the matcher is the part that has to be boring and exact. Two wildcards and
 * no more, chosen because a surprising match on a shared file is worse than a
 * missing feature.
 */
describe("matchesGlob", () => {
  it("treats a wildcard-free glob as an exact path", () => {
    expect(matchesGlob("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
    expect(matchesGlob("apps/pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(false);
    // CANARY: forget to escape `.` and this matches, because `.` is any char.
    expect(matchesGlob("pnpm-lockXyaml", "pnpm-lock.yaml")).toBe(false);
  });

  it("`*` stays inside ONE segment", () => {
    expect(matchesGlob("make/test.mk", "make/*.mk")).toBe(true);
    expect(matchesGlob("make/ci.mk", "make/*.mk")).toBe(true);
    // CANARY: render `*` as `.*` and this matches, so a lease on one directory
    // silently claims every directory under it.
    expect(matchesGlob("make/sub/test.mk", "make/*.mk")).toBe(false);
    expect(matchesGlob("make/test.txt", "make/*.mk")).toBe(false);
  });

  it("`**` spans whole segments, and covers the directory itself", () => {
    expect(matchesGlob("services/cart/src/index.ts", "services/cart/**")).toBe(true);
    expect(matchesGlob("services/cart/package.json", "services/cart/**")).toBe(true);
    // A lease on a directory means the directory: a task that DELETES it has
    // touched it, and `git log --name-only` reports the path.
    // CANARY: drop the `bare` arm and a deletion slips the lease.
    expect(matchesGlob("services/cart", "services/cart/**")).toBe(true);
    expect(matchesGlob("services/catalog/src/index.ts", "services/cart/**")).toBe(false);
    // The neighbour trap: `cart` must not claim `cart-api`.
    expect(matchesGlob("services/cart-api/src/index.ts", "services/cart/**")).toBe(false);
  });

  it("`**/` in the middle matches zero segments as well as many", () => {
    expect(matchesGlob("a/b", "a/**/b")).toBe(true);
    expect(matchesGlob("a/x/b", "a/**/b")).toBe(true);
    expect(matchesGlob("a/x/y/b", "a/**/b")).toBe(true);
    expect(matchesGlob("a/x/y/c", "a/**/b")).toBe(false);
  });

  it("normalises a leading ./ and a trailing slash rather than missing the match", () => {
    expect(matchesGlob("./pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
    expect(matchesGlob("services/cart/src/index.ts", "services/cart/")).toBe(false);
    expect(matchesGlob("services/cart", "services/cart/")).toBe(true);
  });

  it("an empty glob matches nothing, rather than everything", () => {
    // CANARY: drop the `if (!g) return false` guard — an empty string compiles
    // to `^$`, but a lease row that lost its path must never be read as a
    // lease on the repository root either.
    expect(matchesGlob("anything", "")).toBe(false);
    expect(matchesGlob("", "")).toBe(false);
  });

  it("does not let a glob's regex metacharacters escape", () => {
    // A path a careless implementation would treat as a character class.
    expect(matchesGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchesGlob("aab.txt", "a+b.txt")).toBe(false);
    expect(matchesGlob("services/(x)/f", "services/(x)/f")).toBe(true);
  });
});

const LEASES: FileLease[] = [
  { paths: ["pnpm-lock.yaml"], taskKey: "SHOP-11", reason: "regenerating for the cart importer" },
  { paths: ["Makefile", "make/**"], taskKey: "SHOP-19", reason: "splitting it into fragments" },
];

/**
 * Ruling 61: two leases whose globs overlap refuse each other's deliveries, so
 * neither holder can ever land. The exact-duplicate check this replaces caught
 * `internal/**` twice and missed every real case.
 */
describe("globsOverlap", () => {
  it("a directory lease overlaps any lease inside it, in either order", () => {
    // CANARY: fall back to `a === b` and all three read false.
    expect(globsOverlap("internal/sandbox/**", "internal/sandbox/local.go")).toBe(true);
    expect(globsOverlap("internal/sandbox/local.go", "internal/**")).toBe(true);
    expect(globsOverlap("internal/**", "internal/sandbox/**")).toBe(true);
  });

  it("siblings and disjoint trees do not overlap", () => {
    expect(globsOverlap("internal/sandbox/**", "internal/runtime/**")).toBe(false);
    expect(globsOverlap("internal/cli/render.go", "internal/cli/apply.go")).toBe(false);
    expect(globsOverlap("docs/**", "internal/**")).toBe(false);
  });

  it("`*` stays inside a segment on both sides", () => {
    expect(globsOverlap("make/*.mk", "make/test.mk")).toBe(true);
    expect(globsOverlap("make/*.mk", "make/sub/test.mk")).toBe(false);
    // Two star patterns meet when their literal heads and tails are compatible.
    expect(globsOverlap("internal/*/types.go", "internal/apis/*.go")).toBe(true);
    expect(globsOverlap("src/*.ts", "src/*.go")).toBe(false);
    expect(globsOverlap("src/a*", "src/b*")).toBe(false);
  });

  it("`**` in the middle spans zero segments too, and `a/**` covers `a` itself", () => {
    expect(globsOverlap("a/**/b.go", "a/b.go")).toBe(true);
    expect(globsOverlap("a/**", "a")).toBe(true);
    expect(globsOverlap("a/**/z", "a/b/c/z")).toBe(true);
    expect(globsOverlap("a/**/z", "a/b/c/y")).toBe(false);
  });

  it("a `**` inside a segment is answered overlapping, the safe direction", () => {
    expect(globsOverlap("src/**.ts", "docs/readme.md")).toBe(true);
  });

  it("agrees with matchesGlob on every literal path", () => {
    const globs = ["internal/**", "internal/*/x.go", "a/**/b", "make/*.mk", "docs/api.md"];
    const paths = ["internal/sandbox/x.go", "internal/x.go", "a/b", "a/q/r/b", "make/t.mk", "docs/api.md", "other"];
    for (const g of globs) {
      for (const p of paths) expect(globsOverlap(g, p), `${g} vs ${p}`).toBe(matchesGlob(p, g));
    }
  });
});

describe("leaseConflictFor", () => {
  it("names the first changed path another task holds, and its holder", () => {
    const hit = leaseConflictFor(["services/cart/src/a.ts", "Makefile"], LEASES, "SHOP-5");
    expect(hit).toEqual({ path: "Makefile", lease: LEASES[1] });
  });

  it("never refuses the holder its own file", () => {
    // CANARY: drop the `lease.taskKey === taskKey` skip and the lease holder is
    // the one task that cannot deliver the file it was given to own.
    expect(leaseConflictFor(["pnpm-lock.yaml"], LEASES, "SHOP-11")).toBeNull();
    expect(leaseConflictFor(["Makefile", "make/test.mk"], LEASES, "SHOP-19")).toBeNull();
  });

  it("passes a change that touches nothing leased", () => {
    expect(leaseConflictFor(["services/orders/src/saga.ts"], LEASES, "SHOP-27")).toBeNull();
    expect(leaseConflictFor([], LEASES, "SHOP-27")).toBeNull();
    expect(leaseConflictFor(["Makefile"], [], "SHOP-5")).toBeNull();
  });
});

describe("leaseRefusal", () => {
  it("names the file, the holder, the reason and both ways out", () => {
    const hit = leaseConflictFor(["Makefile"], LEASES, "SHOP-5")!;
    const message = leaseRefusal("SHOP-5", hit, "delivering it for review");
    expect(message).toContain("SHOP-5 changes `Makefile`");
    expect(message).toContain("SHOP-19 holds");
    expect(message).toContain("splitting it into fragments");
    expect(message).toContain("before delivering it for review");
    // Both exits, because a refusal that names no way out is the defect this
    // pass keeps finding.
    expect(message).toContain("Drop the change");
    expect(message).toContain("clear the lease");
  });
});
