# Spec — R18-1: reviewer KB context must include the delivering engagement's KBs

**Status:** implementation spec (no code changed yet)
**Owner ruling:** R18-1 — a specialist engaged as a REVIEWER must review against the
same knowledge-base conventions the DELIVERER used. Today grants are strictly
per-profile, so a reviewer with `kb: []` reads none of the deliverer's KBs and
can produce false `request_changes` verdicts.

**One-line fix:** in `startAgentRun`, for a *non-delivering* (reviewer) run, union the
delivering engagement's resolved `resources.kb` into the run's `kb` list (deduped)
*before* `buildSpecialistPersona` → `readKbBodies` is called. The delivering run and
the operator run are untouched.

---

## 1. Where the reviewer run assembles its `kb` list

**File:** `app/server/tasks/specialist-run.server.ts`
**Function:** `startAgentRun` (exported, begins at line 589).

The `kb` list for *every* engaged agent run (deliverer AND reviewer — one uniform
path since generic-agents) is built here:

- `app/server/tasks/specialist-run.server.ts:632` — `const delivers = engagement.delivers;`
  For a reviewer run `delivers === false`.
- `app/server/tasks/specialist-run.server.ts:688` — `let kb: string[] = [];`
- `app/server/tasks/specialist-run.server.ts:700-717` — the `if (resolved) { … }` block
  that sets the run's resources from the *current engagement's own* profile:
  ```ts
  if (resolved) {
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;              // ← line 703: reviewer gets ONLY its own KBs today
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
    …
  }
  ```
  Here `resolved = resolveDeployedSpecialist(ctx, projectSlug, engagement.profileId)`
  (line 665-669), i.e. the profile being *run*. For a reviewer run that is the
  reviewer's profile, so `kb` = the reviewer's own grants only.
- `app/server/tasks/specialist-run.server.ts:723-729` — the stage-eligibility assert
  (`if (resolved) assertStageEligible(...)`).
- `app/server/tasks/specialist-run.server.ts:737-747` — the `kb` list is consumed:
  ```ts
  const resolvedMcps = mcpServersFor(db, mcpNames);
  const persona = buildSpecialistPersona({
    profileId: engagement.profileId,
    skills,
    kb,                            // ← consumed here
    mcps: Object.keys(resolvedMcps.mcpServers ?? {}),
    …
  });
  ```
  `buildSpecialistPersona` (line 1097) calls
  `readKbBodies(input.kb ?? [], input.dataRoot, KB_INJECTION_BUDGET)` at
  `app/server/tasks/specialist-run.server.ts:1143`, which resolves each KB *name* to a
  `data/kb/<name>/` store folder via `readKbBodyDetailed` /
  `app/server/files/kb-injection.server.ts` (`kbDirPath` → `<dataRoot>/kb/<name>`).

**So the entire fix is one insertion between line 729 and line 737** — after `kb` is
finalized from the reviewer's own profile and after the stage-eligibility gate, and
before the persona (and therefore `readKbBodies`) is built.

---

## 2. How to obtain the delivering engagement's KB set at reviewer-run time

**It is derivable from project.md via the delivering engagement — no new task-file
field is needed.**

Data path, all available inside `startAgentRun`:

1. `existing.parsed.frontmatter` — already read at line 617-618
   (`const existing = readTaskFile(taskRef(...))`).
2. `deliveringEngagement(existing.parsed.frontmatter)` →
   `Engagement | null`. This is the single `delivers: true` engagement (the
   workspace/branch/PR owner). Helper is defined at
   `app/schemas/task-file.schema.ts:125-129` and is **already imported** at
   `app/server/tasks/specialist-run.server.ts:6-7`.
3. `deliverer.profileId` → `resolveDeployedSpecialist(ctx, projectSlug, deliverer.profileId).kb`.
   `resolveDeployedSpecialist` (line 223) reads project.md `agents:` and returns
   `ResolvedSpecialist.kb`, which is `view.resources.kb` — resolved by
   `effectiveProfileView` from the deployment's loose `definition.resources.kb`
   (else the org template's `resources.kb`) at
   `app/features/agents/agents-query.server.ts:336-340`.

This is the same live-deployment resolution the run already uses for the reviewer's
own profile, so the reviewer's own KBs and the deliverer's KBs are resolved
identically and consistently.

### Why the delivering *engagement* (not `workRevision.sourceProfileId`)

- The ruling says "the KB grants that the **DELIVERING engagement** used" — present
  tense, the current deliverer. `deliveringEngagement(fm)` maps to it directly and is
  always present whenever a deliverer exists.
- `workRevision.sourceProfileId`
  (`app/schemas/task-file.schema.ts:442`) records "the delivering engagement's
  profileId that produced this revision". In the common case it is identical to the
  current deliverer. It is *nullable* and only exists once a revision has been
  delivered, so it is a strictly weaker signal for the general reviewer run (a
  reviewer can be run before a revision exists). **Use `deliveringEngagement(fm)`.**
  (If a later ruling wants the exact producer of the reviewed head, prefer
  `workRevision.sourceProfileId` when non-null and fall back to
  `deliveringEngagement`; not needed for R18-1.)

---

## 3. The precise code edit

**File:** `app/server/tasks/specialist-run.server.ts`
**Insertion point:** immediately after the stage-eligibility block that ends at
line 729, before the persona comment at line 731. No new imports
(`deliveringEngagement` is already imported; `resolveDeployedSpecialist` is local).

### Before (lines 719-738, verbatim)

```ts
  // Stage eligibility holds at the RUN boundary too (F1): an already-engaged
  // agent must not be re-run after the task moved to a stage it isn't eligible
  // for. Outside the try so the undeployed-profile fallback can't swallow it.
  // An undeployed profile declares no stages to check against — the withheld
  // confinement above is what bounds that run instead (P14-RT-01).
  if (resolved) {
    assertStageEligible(
      resolved,
      existing.parsed.frontmatter.stage,
      projectBoard(ctx, input.projectSlug),
    );
  }

  // The agent's run persona: its detailed definition + declared skills + KB
  // docs. Claude takes it as a system prompt; Codex receives the same persona
  // through the supported `developer_instructions` configuration channel.
  // P14-LV-09: resolve BEFORE the persona, and build it from what actually
  // mounted — passing the DECLARED names is the literal symptom (the prompt
  // announced a server the run had no tools for).
  const resolvedMcps = mcpServersFor(db, mcpNames);
  const persona = buildSpecialistPersona({
```

### After (insert the marked block between the eligibility block and the persona comment)

```ts
  // Stage eligibility holds at the RUN boundary too (F1): an already-engaged
  // agent must not be re-run after the task moved to a stage it isn't eligible
  // for. Outside the try so the undeployed-profile fallback can't swallow it.
  // An undeployed profile declares no stages to check against — the withheld
  // confinement above is what bounds that run instead (P14-RT-01).
  if (resolved) {
    assertStageEligible(
      resolved,
      existing.parsed.frontmatter.stage,
      projectBoard(ctx, input.projectSlug),
    );
  }

  // R18-1: a REVIEWER must judge the work against the SAME knowledge-base
  // conventions the DELIVERER used. Grants are per-profile, so a reviewer with
  // `kb: []` (or a different KB set) reviewed against different conventions and
  // produced false `request_changes` verdicts. Union the delivering
  // engagement's live KB grants into this reviewer run's kb list — reviewer's
  // own KBs first, the deliverer's extras appended, deduped so a KB both grant
  // never injects (or double-charges the shared budget) twice. Only for a
  // non-delivering run: the deliverer's own run already carries these, and the
  // operator runs a separate path (buildOperatorSystemPrompt), so both are
  // untouched. Tolerant of an undeployed deliverer (resolve throws → skip),
  // exactly like the reviewer's own resolve above.
  if (!delivers) {
    const deliverer = deliveringEngagement(existing.parsed.frontmatter);
    if (deliverer && deliverer.profileId !== engagement.profileId) {
      try {
        const deliveringKb = resolveDeployedSpecialist(
          ctx,
          input.projectSlug,
          deliverer.profileId,
        ).kb;
        const own = new Set(kb);
        for (const name of deliveringKb) {
          if (!own.has(name)) {
            own.add(name);
            kb = [...kb, name];
          }
        }
      } catch {
        // Deliverer undeployed since delivery — its live grants can't be
        // confirmed, so add nothing. The reviewer still gets its own KBs.
      }
    }
  }

  // The agent's run persona: its detailed definition + declared skills + KB
  // docs. Claude takes it as a system prompt; Codex receives the same persona
  // through the supported `developer_instructions` configuration channel.
  // P14-LV-09: resolve BEFORE the persona, and build it from what actually
  // mounted — passing the DECLARED names is the literal symptom (the prompt
  // announced a server the run had no tools for).
  const resolvedMcps = mcpServersFor(db, mcpNames);
  const persona = buildSpecialistPersona({
```

### Properties this satisfies

- **No duplication:** the `own` set dedupes; a KB the reviewer already grants is
  never appended again, so `readKbBodies` (which draws each KB from one shared
  `KB_INJECTION_BUDGET`, `kb-injection.server.ts:304-321`) is not double-charged.
- **Ordering:** the reviewer's own KBs stay first (its primary craft), the
  deliverer's extras append — deterministic and matches the "union" intent.
- **Delivering run untouched:** gated on `!delivers`. For the deliverer,
  `deliveringEngagement(fm).profileId === engagement.profileId`, so even without the
  guard nothing would be added — the guard also skips the wasted resolve call.
- **Operator untouched:** operators never reach `startAgentRun`; their KBs are
  injected by `buildOperatorSystemPrompt` in
  `app/server/runtimes/operator-run.server.ts`.
- **Missing folder tolerant:** union adds only KB *names*; `readKbBodyDetailed`
  already tolerates an absent/renamed/symlinked/empty folder by injecting nothing
  and emitting the structured "did NOT reach this run" marker
  (`kb-injection.server.ts:161-278`). No change needed there.

### Resume path (recommended companion edit — same bug on `@mention`/resumed reviews)

`resolveResumeConfinement` (line 1472) rebuilds the persona for a *resumed* reviewer
run and has the identical omission at
`app/server/tasks/specialist-run.server.ts:1512-1521`:

```ts
const persona = buildSpecialistPersona({
  profileId: input.profileId,
  skills: resolved.skills,
  kb: resolved.kb,               // ← same per-profile-only KB list
  …
});
```

`resolveResumeConfinement` receives `input.delivers?: boolean`, `input.projectSlug`,
`input.taskKey`, `ctx`, and `db`, so it can read the task file and apply the same
union. Apply the same `!delivers` union to `resolved.kb` before this
`buildSpecialistPersona` call so a resumed/`@mention`-driven review keeps the
deliverer's KBs it had on the fresh run. Recommended for parity (a resumed reviewer
otherwise silently loses the deliverer's conventions mid-conversation); if scoped
out, note it explicitly — the fresh-run fix at §3 is the primary R18-1 requirement.

---

## 4. Edge cases

| Case | Behavior with this edit |
|---|---|
| **No delivering engagement yet** | `deliveringEngagement(fm)` returns `null` → union skipped; reviewer uses only its own KBs. Correct — nothing was delivered to review against. |
| **Deliverer grants no KBs** | `resolveDeployedSpecialist(deliverer).kb === []` → loop adds nothing. Reviewer unchanged. |
| **Deliverer's granted KB folder missing/renamed/empty/symlinked** | Name is unioned into `kb`; `readKbBodyDetailed` injects nothing and emits the structured "Attached resources that did NOT reach this run" marker (existing tolerance, `kb-injection.server.ts:161-278`). No crash, no silent drop. |
| **KB granted by BOTH reviewer and deliverer** | `own` set dedupes → injected once, budget charged once. |
| **Deliverer undeployed since delivery** | `resolveDeployedSpecialist` throws → `catch` adds nothing; reviewer keeps its own KBs (matches the existing undeployed-profile tolerance at lines 663-672). |
| **Delivering run (`delivers === true`)** | Guarded out — its `kb` is exactly its own grants, unchanged. |
| **Operator run** | Never enters `startAgentRun`; uses `buildOperatorSystemPrompt`. Unaffected. |
| **Reviewer's own profile undeployed** (`resolved === null`, `kb === []`) | Union still runs (it operates on the `kb` variable, not on `resolved`), so the reviewer still gets the deliverer's KBs. |

---

## 5. Test plan

**File to extend:** `app/server/tasks/specialist-run.server.test.ts` (the reviewer-run
surface already lives here; it imports `startAgentRun`, `assignReviewer`,
`assignSpecialist`, and uses `installFakeRuntime()` + `lastRunSpec()`).

**Inspection mechanism:** the fake runtime records every `RunSpec`; the persona is
threaded to `RunSpec.systemPrompt` (`startRun` maps `systemPrompt` →
`run-service.server.ts:434`, and `adapter.server.ts:39`). Import `lastRunSpec` from
`../../../test-support/fake-runtime` and assert on `lastRunSpec()?.systemPrompt`.
(`buildSpecialistPersona` returns a non-empty string here because the KB resource
bodies + trusted banner are emitted even with no `definition`.)

### Test helpers to add (local to a new `describe`)

Deploy two specialists — a deliverer that grants KB `"foo"` and a reviewer that
grants none — by writing project.md directly (same pattern as `deployDevSpecialist`
/ `deploySecond` in this file, with `resources` added to the loose `definition`):

```ts
function deployReviewerKbFixture(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null, // no clone — keep the run offline/fast
    agents: [
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist", name: "dev", role: "developer",
          backends: ["claude"], model: "sonnet",
          resources: { skills: [], mcps: [], kb: ["foo"] },
        },
      } as never,
      {
        profileId: "critic",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist", name: "critic", role: "reviewer",
          backends: ["claude"], model: "sonnet",
          resources: { skills: [], mcps: [], kb: [] }, // reviewer grants NO KB
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function writeKb(name: string, doc: string, body: string): void {
  mkdirSync(path.join(store.dataRoot, "kb", name), { recursive: true });
  writeFileSync(path.join(store.dataRoot, "kb", name, doc), body);
}
```

`mkdirSync`, `writeFileSync`, `path`, `readProjectFile`, `writeProject`,
`rebuildAll`, `lastRunSpec` are all already imported in this file (add `lastRunSpec`
from `fake-runtime` if not).

### Primary test (the one the task calls for)

```ts
describe("startAgentRun — R18-1 reviewer inherits the deliverer's KBs", () => {
  it("a reviewer with kb:[] resolves the delivering engagement's KB bodies", async () => {
    deployReviewerKbFixture();
    writeKb("foo", "conventions.md", "# Conventions\n\nSENTINEL-DELIVERER-KB");

    // dev delivers; critic reviews.
    await assignSpecialist(store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda), { dataRoot: store.dataRoot });
    await assignReviewer(store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "critic" },
      actor(store.users.arda), { dataRoot: store.dataRoot });

    const result = await startAgentRun(store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "critic" },
      actor(store.users.arda), { dataRoot: store.dataRoot });
    expect(result.role).toBe("reviewer");

    const sys = lastRunSpec()?.systemPrompt ?? "";
    // The deliverer's KB reached the reviewer's persona…
    expect(sys).toContain("foo (knowledge base)");
    expect(sys).toContain("SENTINEL-DELIVERER-KB");

    // …and settle the run.
    const { interruptRun } = await import("~/server/runtimes/run-service.server");
    interruptRun(store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: result.runId },
      actor(store.users.arda));
  });
```

### Companion tests (edge coverage + canary)

```ts
  it("no duplicate when reviewer and deliverer both grant the same KB", async () => {
    // Same as above but critic's definition.resources.kb = ["foo"].
    // Assert the "foo (knowledge base)" heading appears exactly once.
    // e.g. expect(sys.split("foo (knowledge base)").length - 1).toBe(1);
  });

  it("the DELIVERING run is unaffected — deliverer sees only its own KBs", async () => {
    // Run `dev` as the deliverer (omit profileId → delivering engagement).
    // Assert its systemPrompt does NOT gain any KB it did not grant. (Give the
    // reviewer a distinct KB "bar" and assert the deliverer's prompt lacks it.)
  });

  it("reviewer with no delivering engagement uses only its own KBs (no throw)", async () => {
    // Engage only `critic` (grant it kb:["baz"] + write kb/baz), run it, assert
    // its own KB is present and startAgentRun does not throw.
  });
```

**Canary:** reverting the §3 union block makes the *primary* test fail on the
`SENTINEL-DELIVERER-KB` assertion (the reviewer's persona would carry none of the
deliverer's KB), confirming the test pins exactly this behavior.

### Optional pure-unit alternative

If a machinery-free unit test is preferred, extract the dedup as a tiny exported
helper (e.g. `export function unionKb(own: string[], extra: string[]): string[]`)
and unit-test dedup/order directly. The delivering-KB *resolution* still needs the
integration test above (it reads project.md via `resolveDeployedSpecialist`), so the
`startAgentRun` test remains the definitive coverage.
