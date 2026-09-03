import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_ROLES,
  PROJECT_ROLES,
  RBAC_DEFINITIONS,
  ROLE_LABEL,
  ROLE_RANK,
  roleCan,
  rolesForAction,
  type ProjectRole,
  type RbacAction,
} from "./rbac";

/**
 * The sibling test `app/shared/rbac.ts` never had (pass-33 coverage inventory).
 *
 * The matrix is exercised end-to-end by `app/features/policy/policy-rbac.server.test.ts`,
 * which drives the REAL server guard for every row as every role — but that file
 * is a full store+db harness, it lives three directories away, and it binds
 * CALL SITES to whatever the table happens to say. This file is the other kind
 * of guard: the module's own invariants, provable in milliseconds, plus the two
 * things nothing anywhere asserted —
 *
 *   1. the docs that call themselves the source of the matrix
 *      (`docs/domain/auth-and-rbac.md` §3, `docs/domain/task-lifecycle.md` §2)
 *      are checked against `ACTION_ROLES` MECHANICALLY, the way ruling 27's PRD
 *      mirror and N19-3's file-formats mirror are (see
 *      `app/shared/docs/file-formats-sync.test.ts`). A hand-corrected doc with
 *      no gate is a fix with a half-life; a role tier that moved in the table
 *      and not in the doc is worse — it is the wrong answer to "who may do
 *      this?", written down and trusted; and
 *   2. `rolesForAction`'s REFUSAL path — the throw on an action id the table
 *      does not know.
 *
 * Ruling 65 states the standard this file is built to: "an owner ruling whose
 * guard cannot go red is a ruling that gets reverted in silence." Every role
 * tier here IS an owner ruling.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/** The check mark the domain docs mark a held cell with (U+2713). */
const CHECK = "✓";

/**
 * A raw `project.md` `members[]` role, handed over as the `string` the
 * loader→props chain has already widened it to — the exact shape
 * `execution-profile.tsx` and `task-side-panels.tsx` pass to `roleCan`.
 */
function asStoredRole(raw: string): ProjectRole {
  // SAFETY: deliberately unchecked. This test exists to prove `roleCan` denies
  // a value that reached it past the type, which is the invariant those two
  // call sites state in a comment and rely on for their widening to be safe.
  return raw as ProjectRole;
}

/** Roles ordered by rank so both sides of a comparison read the same way. */
function byRank(roles: readonly ProjectRole[]): ProjectRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
}

/** The matrix as the code holds it: action id → its roles, rank-ordered. */
function codeMatrix(): Map<string, ProjectRole[]> {
  return new Map(RBAC_DEFINITIONS.map((d) => [d.id, byRank(d.roles)]));
}

/** A markdown table row's trimmed cells, or null when the line is not one. */
function rowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** `|---|---|` and friends carry no data. */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Parse the ONE role matrix out of a domain doc: the table whose header cells,
 * after the leading "Action" column, are exactly the four project roles. Rows
 * name one or more backticked action ids and mark held cells with a check.
 *
 * Found structurally, not by heading text, so re-titling a section does not
 * quietly turn this test into a no-op — the "exactly one" assertion is what
 * makes a vanished table fail loudly instead of comparing an empty map.
 */
function docMatrix(relPath: string): Map<string, ProjectRole[]> {
  const lines = readFileSync(path.join(ROOT, relPath), "utf8").split("\n");
  const headerRows = lines.filter((line) => {
    const cells = rowCells(line);
    if (cells === null) return false;
    const [, ...roleCells] = cells;
    return (
      roleCells.length === PROJECT_ROLES.length &&
      PROJECT_ROLES.every((role) => roleCells.includes(role))
    );
  });
  expect(
    headerRows.length,
    `${relPath} must carry exactly one role matrix (header: | Action | ${PROJECT_ROLES.join(" | ")} |)`,
  ).toBe(1);
  const start = lines.indexOf(headerRows[0]!);
  const header = rowCells(lines[start]!)!;
  const matrix = new Map<string, ProjectRole[]>();
  for (let i = start + 1; i < lines.length; i += 1) {
    const cells = rowCells(lines[i]!);
    if (cells === null) break;
    if (isSeparatorRow(cells)) continue;
    const ids = [...cells[0]!.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    expect(ids.length, `${relPath} row names no action id: ${lines[i]}`).toBeGreaterThan(0);
    // Read each role from ITS OWN column, located by the header, so a reordered
    // doc table compares equal and a mis-shifted check mark does not.
    const held = PROJECT_ROLES.filter(
      (role) => cells[header.indexOf(role)] === CHECK,
    );
    for (const id of ids) matrix.set(id, byRank(held));
  }
  return matrix;
}

describe("the role tier: viewer ⊂ contributor ⊂ maintainer ⊂ admin", () => {
  /**
   * The tier is the property every consumer leans on: the guards pass
   * `rolesForAction(action)` to `requireProjectAuthority` as a flat allow-list,
   * the Policy page renders one column per role, and `ownerException` asks
   * `roleCan(role, "own-task")` to mean "contributor or above". If one action's
   * set ever skipped a rung — say maintainer-and-viewer-but-not-contributor —
   * none of that would report an error; it would just hand out (or withhold)
   * authority in a shape no page explains and no ruling decided.
   */
  it("holds every action at a rank FLOOR — a grant never skips a role", () => {
    for (const def of RBAC_DEFINITIONS) {
      const floor = Math.min(...def.roles.map((role) => ROLE_RANK[role]));
      const upwardClosed = PROJECT_ROLES.filter((role) => ROLE_RANK[role] >= floor);
      expect(
        byRank(def.roles),
        `"${def.id}" must be every role at or above its floor, not an arbitrary set`,
      ).toEqual(byRank(upwardClosed));
    }
    // The ranks themselves are the tier's spine: a re-numbering that reordered
    // two roles would keep the loop above green while inverting the meaning.
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.contributor);
    expect(ROLE_RANK.contributor).toBeLessThan(ROLE_RANK.maintainer);
    expect(ROLE_RANK.maintainer).toBeLessThan(ROLE_RANK.admin);
  });

  /**
   * R15-4: membership is the OUTER gate on every row. A non-member never
   * reaches a role check at all (the layout loader and `requireVisibleProject`
   * answer the unknown-slug 404 first), so `roleCan(null, …)` is what every
   * render path asks about a signed-in stranger — and it must be a plain
   * `false`, for every action, never a throw: `task-side-panels.tsx` renders
   * the whole permission summary with a possibly-null role.
   */
  it("refuses a non-member for every action, without throwing", () => {
    for (const def of RBAC_DEFINITIONS) {
      expect(roleCan(null, def.id), `a non-member must not hold "${def.id}"`).toBe(false);
      expect(roleCan(undefined, def.id), `an absent role must not hold "${def.id}"`).toBe(
        false,
      );
    }
  });

  /**
   * `execution-profile.tsx` and `task-side-panels.tsx` hand `roleCan` a value
   * the loader→props chain has widened to `string`, and both say so in a
   * comment: "roleCan denies any other value, so the widening can only
   * under-grant." That is a claim about THIS function, made at a call site, and
   * nothing checked it. It matters because `project.md` `members[]` is
   * hand-editable: a row that says `Admin` or `owner` must buy nothing.
   */
  it("refuses a string that is not a project role — the widened call sites can only UNDER-grant", () => {
    for (const raw of ["Admin", "owner", "member", "ADMIN", ""]) {
      for (const def of RBAC_DEFINITIONS) {
        expect(
          roleCan(asStoredRole(raw), def.id),
          `"${raw}" is not a project role and must hold nothing`,
        ).toBe(false);
      }
    }
  });

  /**
   * The two ends of the tier, stated as behaviour rather than derived from the
   * table — the derived tests above all stay green if the whole matrix is
   * rewritten. An admin who cannot do something has no recourse (there is no
   * higher project role), and a viewer who can do anything else is a read-only
   * seat that writes.
   */
  it("gives admin every action, and a viewer nothing beyond view + comment", () => {
    for (const def of RBAC_DEFINITIONS) {
      expect(roleCan("admin", def.id), `admin must hold "${def.id}"`).toBe(true);
    }
    const viewerHolds = RBAC_DEFINITIONS.filter((d) => roleCan("viewer", d.id)).map(
      (d) => d.id,
    );
    expect(viewerHolds).toEqual(["view", "comment"]);
  });
});

describe("the matrix is a policy decision, pinned by hand", () => {
  /**
   * Everything derived from `rolesForAction` binds the CALL SITES to the table
   * and cannot see the table move. This is the pin: the floor each action was
   * granted at, written out, so widening one (`manage-agents` to maintainer,
   * say) has to be typed here too. A role tier should never move as a side
   * effect of a refactor.
   *
   * `policy-rbac.server.test.ts` pins the same decision in its full-set form;
   * both are deliberate. This one is the module's own sibling and states the
   * decision the way the tier actually works — as a floor.
   */
  const POLICY_FLOOR = {
    // Every role. Not role-gated at all: their entire enforcement IS the
    // membership gate (R15-4) — neither ever calls `requireAction`.
    view: "viewer",
    comment: "viewer",
    // A contributor creates work, holds their own seat, and grooms scheduling
    // metadata that changes no gate.
    "create-task": "contributor",
    "own-task": "contributor",
    "edit-task-meta": "contributor",
    // Governance of a task's movement, its acceptance contract, its agents and
    // the project's GitHub binding.
    "approve-transition": "maintainer",
    "resolve-packet": "maintainer",
    "accept-completion": "maintainer",
    "update-goal": "maintainer",
    "run-agents": "maintainer",
    "reorder-board": "maintainer",
    "reconcile-github": "maintainer",
    "grant-github-scope": "maintainer",
    "rescan-project": "maintainer",
    // Authority over other people's seats, over who is a member, over the
    // workflow itself, and the audited escape hatch past the review gate.
    "release-any-ownership": "admin",
    "manage-members": "admin",
    "manage-agents": "admin",
    "edit-policy": "admin",
    "force-accept-completion": "admin",
  } satisfies Record<RbacAction, ProjectRole>;

  it("grants each action at exactly the floor the ruling assigned it", () => {
    for (const def of RBAC_DEFINITIONS) {
      const floor = ROLE_RANK[POLICY_FLOOR[def.id]];
      expect(byRank(rolesForAction(def.id)), `"${def.id}" floor`).toEqual(
        byRank(PROJECT_ROLES.filter((role) => ROLE_RANK[role] >= floor)),
      );
    }
  });

  it("pins every action in the table — a new action cannot ship unpinned", () => {
    expect(Object.keys(POLICY_FLOOR).sort()).toEqual(
      RBAC_DEFINITIONS.map((d) => d.id).sort(),
    );
  });
});

/**
 * The domain docs are named "source of truth" at the top of their own files and
 * are what a human reads before answering "may a contributor do this?". Nothing
 * bound them to the code, so the only thing keeping the two matrices equal was
 * that somebody remembered — which is exactly how the packet-kind count in
 * file-formats.md went stale (N19-3). Edit `RBAC_DEFINITIONS`; this makes the
 * doc a mechanical follow-up rather than a thing to remember.
 */
describe("the domain docs render the SAME matrix (ruling 65: the guard must be able to go red)", () => {
  it("docs/domain/auth-and-rbac.md §3 matches ACTION_ROLES exactly", () => {
    expect(docMatrix("docs/domain/auth-and-rbac.md")).toEqual(codeMatrix());
  });

  it("docs/domain/task-lifecycle.md §2 matches ACTION_ROLES exactly", () => {
    expect(docMatrix("docs/domain/task-lifecycle.md")).toEqual(codeMatrix());
  });
});

describe("ACTION_ROLES is the one object the guards and the Policy page share", () => {
  /**
   * The map is BUILT from `RBAC_DEFINITIONS`, and the Policy page renders the
   * definitions array while the guards read the map. Two ids that collide leave
   * the display showing both rows and the map keeping only the last — display
   * and enforcement disagreeing, silently, which is the single failure mode
   * this module's whole design exists to prevent. (`capabilities.ts` really did
   * carry a duplicate id inside a Set for a whole pass — A00-8.)
   */
  it("keys every definition, with no row silently overwritten by a duplicate id", () => {
    expect(ACTION_ROLES.size).toBe(RBAC_DEFINITIONS.length);
    for (const def of RBAC_DEFINITIONS) {
      // Identity, not equality: the guards must read the very array the table
      // renders, never a copy that could be rebuilt from something else.
      expect(ACTION_ROLES.get(def.id), `"${def.id}" is missing from ACTION_ROLES`).toBe(
        def.roles,
      );
    }
  });

  /**
   * An action with no holders is not a safe "deny everyone". `requireAction`
   * hands the set to `requireProjectAuthority`, which — after the member check
   * fails for every role — falls through to the D2 org-admin override. An empty
   * row would therefore convert a governed project action into an org-admin-only
   * one, and the Policy page would render a row of four blanks nobody can
   * explain.
   */
  it("gives every action at least one holder", () => {
    for (const def of RBAC_DEFINITIONS) {
      expect(rolesForAction(def.id).length, `"${def.id}" has no holder`).toBeGreaterThan(0);
    }
  });

  it("names only real project roles, once each", () => {
    for (const def of RBAC_DEFINITIONS) {
      for (const role of def.roles) {
        expect(PROJECT_ROLES, `"${def.id}" names "${role}"`).toContain(role);
      }
      expect(new Set(def.roles).size, `"${def.id}" repeats a role`).toBe(def.roles.length);
    }
  });

  /**
   * The Policy and task-side permission tables draw one column per role from
   * these two objects. A role present in `PROJECT_ROLES` but missing here
   * renders a header cell reading `undefined`; a duplicated label makes two
   * columns indistinguishable.
   */
  it("ranks and labels exactly the four project roles, distinctly", () => {
    expect(Object.keys(ROLE_RANK).sort()).toEqual([...PROJECT_ROLES].sort());
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...PROJECT_ROLES].sort());
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(PROJECT_ROLES.length);
    expect(new Set(Object.values(ROLE_LABEL)).size).toBe(PROJECT_ROLES.length);
  });
});

describe("rolesForAction refuses an action the table does not know", () => {
  /**
   * The refusal path, and the reason it must be a THROW.
   *
   * `requireAction(db, project, actor, action, what)` is called from ~40 server
   * sites; the action id is a literal at most of them, but it also arrives
   * through `RbacAction`-typed parameters (`assertProjectAction`,
   * `settings-actions.server.ts`) where a wrong-but-well-typed value is
   * possible. If a miss returned an empty allow-list instead of throwing, the
   * guard would refuse every project member — and then pass the actor to the
   * org-admin override. A typo'd action would look exactly like a correct 403
   * to everyone except an org admin, forever. The loud crash is the feature.
   */
  it("throws and names the action instead of returning an empty allow-list", () => {
    // SAFETY: the whole point is a value that reached the function past the
    // type — a plausible typo of `manage-members`.
    const typo = "manage-membrs" as RbacAction;
    expect(() => rolesForAction(typo)).toThrow(/unknown RBAC action: manage-membrs/);
    expect(() => roleCan("admin", typo)).toThrow(/unknown RBAC action/);
  });
});

describe("the narrower-gate relationships the module's comments promise", () => {
  /** Every holder of `narrow` also holds `wide`, and `narrow` is smaller. */
  function assertStrictlyNarrower(narrow: RbacAction, wide: RbacAction): void {
    const wider = new Set<ProjectRole>(rolesForAction(wide));
    for (const role of rolesForAction(narrow)) {
      expect(
        wider.has(role),
        `"${narrow}" must not reach a role that cannot "${wide}"`,
      ).toBe(true);
    }
    expect(
      rolesForAction(narrow).length,
      `"${narrow}" must be STRICTLY narrower than "${wide}"`,
    ).toBeLessThan(rolesForAction(wide).length);
  }

  /**
   * DG-2: force-accept is the audited escape hatch AROUND the required-reviewer
   * gate. Levelling it with plain `accept-completion` would let a maintainer
   * step past a review they could not otherwise skip — the escape hatch has to
   * stay the stricter of the two, or it stops being an escape hatch and becomes
   * the door.
   */
  it("force-accept-completion is strictly narrower than accept-completion", () => {
    assertStrictlyNarrower("force-accept-completion", "accept-completion");
  });

  /**
   * Taking your OWN task is a contributor's job; taking someone else's away is
   * not. If these ever levelled, `release-any-ownership` would stop being the
   * separate decision the release-confirm dialog asks the admin to make.
   */
  it("release-any-ownership is strictly narrower than own-task", () => {
    assertStrictlyNarrower("release-any-ownership", "own-task");
  });

  /**
   * The source comment on `edit-task-meta` draws this line explicitly: the goal
   * is the reviewable acceptance contract, priority/labels/due-date is
   * scheduling metadata that changes no gate. A contributor grooms the second
   * and must not rewrite the first — editing the goal is editing what
   * "completed" will be measured against.
   */
  it("update-goal is strictly narrower than edit-task-meta", () => {
    assertStrictlyNarrower("update-goal", "edit-task-meta");
  });

  /**
   * R15-4 again, from the other side: exactly two rows are held by all four
   * roles, and the docs state membership scope once, under the table, on their
   * behalf. A third all-roles row would be an action whose only enforcement is
   * membership — which may well be right, but it is a ruling, not a typo, and
   * the doc sentence would need to grow with it.
   */
  it("view and comment are the ONLY actions no role tier narrows", () => {
    const untiered = RBAC_DEFINITIONS.filter(
      (d) => d.roles.length === PROJECT_ROLES.length,
    ).map((d) => d.id);
    expect(untiered).toEqual(["view", "comment"]);
  });
});
