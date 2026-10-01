# Arc UI (uiarc.dev): research, 2026-10-01

The request was: "get this skill: https://uiarc.dev/r/arc-skill.json and https://uiarc.dev,
investigate deeply how it can be implementable here". This note answers it. It changes no
code, installs nothing and records no ruling. It is not canon.

Two kinds of evidence went into it.

- **Arc, read first-hand.** `arc-skill.json`, `arc-foundation.json`, the registry index
  `r/registry.json`, `llms.txt`, the licence page and four component items (`button`,
  `segmented-control`, `dialog`, `animated-counter`) were fetched with a plain HTTP client
  on 2026-10-01. Arc's MCP server was asked for `initialize` and `tools/list`. No shadcn CLI
  ran. Hashes are under Sources. The upstream GitHub repository was not read.
- **Viberr, read against the tree at `28c8a07`.** Six read-only reader passes covered
  governance, motion and the performance budget, CSS and the class gate, developer skill
  installation, product-side skills and MCP, and candidate UI surfaces. They returned 92
  findings. Two adversarial verifiers re-opened every cited line: none was refuted, 35 were
  corrected in detail, and this note uses the corrected facts. Repo facts are cited as
  `path:line`.

## Bottom line

Arc is a well-made library, and its skill is a careful piece of agent guidance. But both
are written for a project that adopts Arc's whole design system. Viberr's rulings rule out
that adoption, and parts of the skill contradict Viberr's tested rules directly.

- **Do not install `arc-skill` into this repository as shipped.** Its documented install
  is `npx shadcn add`, which `AGENTS.md:68` and ruling 166 ban. It also tells agents to
  remove focus rings, which `app/app.css.test.ts:146` (P16-UI-01) requires. It requires
  `lucide-react`, which ruling 166 names as banned. And it sets Geist as the display face,
  where ruling 365(a) decided "Inter carries `--font-body` and `--font-display` alike". Its
  trigger also fires on any "build or polish UI" task. Committed as-is, it would steer every
  UI change in this repo against the rulings.
- **Do not bring Arc components or `arc-foundation` into `app/`.** 118 of the registry's
  124 items depend on `motion` and 77 on `lucide-react`. 122 of them pull in a token sheet
  that redefines seven of Viberr's tokens with different values. It also sets `outline:
  none !important` on every focused element.
- **Three routes stay open, ranked:**
  1. **Arc for the agents Viberr runs on delivered projects** (Path 3). No code is needed.
     Arc's MCP server is public, unauthenticated, read-only Streamable HTTP. An org admin
     can register it and paste the skill today. Ruling 166 governs Viberr's own `app/`, not
     the projects Viberr delivers.
  2. **Arc as a read-only design reference for Viberr's own UI** (Path 2). Ruling 166
     permits this reading, and rulings 499 and 451 set the precedent. The yield is small,
     because Viberr already ships most of what Arc advertises. The clearest gap is
     disclosure bodies that snap open, and it already has a house answer in `reveal-down`.
  3. **A Viberr-native adaptation of the skill for developers** (Path 1). This would keep
     Arc's motion, copy, SSR and responsive guidance and its catalogue lookups, and replace
     the install, token, type, icon and focus instructions with Viberr's. Most of what
     survives overlaps the six animation skills already tracked. This is an owner decision
     (precedent: ruling 512).

## What Arc is

**The library.** A React component and block library "designed for AI-assisted frontend
development" (`llms.txt:3`): "Components and blocks share design tokens, CSS modules, and
Motion." `llms.txt` lists 255 entries and says "122 of 223 items are free". The public
registry (`r/registry.json`) carries 124 items: 100 `registry:ui`, 22 `registry:block`, one
`registry:item` (`arc-foundation`) and one `registry:file` (`arc-skill`). All are tier
`free`. Pro items install from a token-gated `@uiarc-pro` registry.

**Dependencies across the 124 public items:**

| npm dependency | items |
|---|---|
| `motion` | 118 |
| `lucide-react` | 77 |
| `@radix-ui/react-dialog` / `-dropdown-menu` | 4 each |
| `@radix-ui/react-popover` | 3 |
| `@radix-ui/react-tabs` | 2 |
| `@radix-ui/react-select`, `-checkbox`, `-switch`, `-accordion`, `-tooltip` | 1 each |

122 items list `arc-foundation` in `registryDependencies`. The four component items read in
full each ship one `.tsx` and one `.module.css`, import `motion/react` (the full React entry,
not `LazyMotion` or `motion/mini`), and honour reduced motion through `useReducedMotion`,
which reads the OS setting. `dialog` adds `@radix-ui/react-dialog` and `lucide-react`.

**The foundation (`arc-foundation`).** Three files: `foundation.css` (13,560 characters) and
two `motion-tokens.ts` modules. In `foundation.css`:

- `:root` tokens in oklch and hex, a dark theme on `:root[data-theme="dark"]` (the same
  attribute Viberr uses), and eight accents on `data-accent`.
- `--focus-ring: transparent` with the comment "Product decision: no focus rings anywhere"
  (`foundation.css:41-42`).
- `:is(*:focus, *:focus-visible, *:focus-within) { outline: none !important; }`
  (`foundation.css:179`).
- Geist as `--font-display` and Inter as `--font-body` (`:65-66`). Radii are 18, 26 and
  34 px (`:63`).

Seven of its custom properties share a name with one in `app/app.css` and differ in value:
`--border`, `--danger`, `--font-body`, `--font-display`, `--radius-panel`, `--success`
and `--surface`. Two examples: `--surface` is `#ffffff` in Viberr (`app/app.css:9`), and
`--radius-panel` is 22 px in Viberr (`app/app.css:258`) against Arc's 26 px.

**The skill (`arc-skill`).** A `registry:file` item with no `dependencies` and no
`registryDependencies`. Its 13 files total 75,335 characters: `SKILL.md`,
`INSTRUCTIONS.md`, `accessibility.md`, `checklist.md`, `components.md`, `composition.md`,
`copy.md`, `design.md`, `motion.md`, `responsive.md` and three worked examples (settings,
pricing, dashboard). Every `target` is `~/.claude/skills/arc/<file>`. In shadcn's registry
schema `~` is the project root ("Use `~` to refer to the root of the project", shadcn
`registry-item-json` docs), so the CLI would write the files into this repository's
`.claude/skills/arc/`. The item's own `docs` field says the same: "Installed to
`.claude/skills/arc/`". The `SKILL.md` frontmatter is a YAML mapping, `name: arc`, with a
675-character description. Its workflow is find (MCP or `llms.txt`), then install
(`npx shadcn@latest add @uiarc/...`, `SKILL.md:29`), wire, compose, style and copy, and
review against `checklist.md` "until every line passes".

**The MCP server.** `https://uiarc.dev/api/mcp`, Streamable HTTP, protocol `2025-06-18`,
answering with plain JSON. It needs no credential for free content. Its five tools are all
read-only:

- `list_components`
- `search_components`
- `get_component`
- `get_install_command`
- `get_skill`, which serves the skill files by name

Its `initialize` instructions tell agents to "install free items with get_install_command
(shadcn CLI)".

**Licence.** Free items are MIT, "Copyright (c) 2026 Elia Kuratli". Pro source is under the
Arc Pro licence, which forbids redistributing or reselling it as a library, kit or template.
The page is dated September 26, 2026 and marked "Draft, pending review. This text has not
been reviewed by a lawyer yet and may change before launch." The skill and the MCP both tell
agents never to reconstruct Pro source (`SKILL.md:24`; `llms.txt:49`). That matches ruling
499(g), which declined to recreate AICSS's Pro components because "their licence reserves
the code" (`docs/architecture/decisions.md:9703`).

## Where the skill meets Viberr's rules

Each row compares an instruction in the skill with the rule or test it meets here. "Agrees"
means an agent following Arc would do what Viberr already requires.

| Arc says | Viberr rule | Result |
|---|---|---|
| Install every item with `npx shadcn@latest add @uiarc/…` and add a `components.json` registry (`SKILL.md:29-32`); "Never rebuild an Arc item from scratch" (`SKILL.md:24`) | "Run `npx shadcn add` (or paste a shadcn/ReUI component)" is under "Do not" (`AGENTS.md:68-69`); ruling 166: "`npx shadcn add` is not a viberr workflow — a registry component is read as a design reference … never installed" (`decisions.md:3684-3685`). The `package.json` denylist fails `shadcn`, `lucide-react`, `tailwind-merge` and others (`app/app.css.test.ts:610-621, 634`) | **Contradicts.** Viberr's reading of a registry *is* the rebuild |
| "Focus rings, outlines, or `:focus-visible` halos. Arc removes them by design" (`SKILL.md:49`; `INSTRUCTIONS.md:34`; `accessibility.md:5-9`). The checklist sweep flags every `outline:` and `:focus-visible` (`checklist.md:12, 74`) | P16-UI-01: "declares one app-wide :focus-visible ring on the brand accent" (`outline: 2px solid var(--blue)`), covering ten control kinds, at 3:1 in both themes, because "axe does not catch it (2.4.7 / 2.4.11 are manual)" (`app/app.css.test.ts:146-195`) | **Contradicts.** The test checks only that the rule exists in `app/app.css`. Importing `foundation.css` would leave the test green and kill the ring in the browser through `!important` |
| Icons from `lucide-react` (`design.md:109`) | Ruling 166 names `lucide-react` as forbidden; one `Icon` component (`decisions.md:155`) | **Contradicts** |
| Geist for headings of 30 px and up (`INSTRUCTIONS.md:23`; `design.md:61`) | Ruling 365(a): "Inter carries `--font-body` and `--font-display` alike" | **Contradicts** |
| Weights 400 and 500 only (`SKILL.md:41`; `checklist.md:29`) | 193 lines in `app/` set weight 600 or more. Ruling 365(g) puts "the page title at 600" | **Contradicts house style** |
| No uppercase or eyebrow text (`SKILL.md:47`; `copy.md`) | 111 lines in `app/` match the skill's own sweep (`uppercase\|eyebrow\|overline\|kicker`) | **Contradicts house style.** Owner's call whether that is wrong |
| Radii 18, 26, 34 px; `--radius-*` from `foundation.css` (`design.md:79`) | Exactly six `--radius-*` tokens with fixed values, and every `border-radius` a token or a small literal (`app/app.css.test.ts:2476-2517`) | **Contradicts** |
| Skeleton for every loading region (`INSTRUCTIONS.md:27`; `components.md:95`); tooltips (`components.md:77`); a sliding `layoutId` highlight for segmented controls and tabs (`motion.md:20, 58`) | Ruling 451 rejected sliding tabs, shimmer on cards, skeletons, tooltips and banner stacking (`decisions.md:9542`). Reviving one is an open re-ruling (`AGENTS.md:62`) | **Contradicts a ruling** |
| Presses scale to about 0.97 (`motion.md:41`) | Ruling 459(d): .96 for controls, .99 for surfaces, never below .95, on `--ease-out` (`decisions.md:9574`; F30 at `app/app.css.test.ts:4849`) | **Close, but not the house values** |
| Semantic tokens only, no raw hex (`INSTRUCTIONS.md:21, 35`) | "No inline hex colors — use the existing tokens" (`decisions.md:140-141`) | **Agrees in spirit.** But the skill's sweep also flags the 234 hex and `rgb()` lines in `app/app.css`, which *are* Viberr's token declarations |
| No em dashes in copy (`SKILL.md:48`; `copy.md` rule 3) | Copy-ban fails em and en dashes in rendered copy (`app/features/copy-ban.test.ts:927`) | **Agrees.** The skill's sweep cannot tell copy from comments, and `app/` has 13,298 lines with an em dash, almost all in comments |
| A reduced-motion branch for every animation, from the OS setting (`motion.md`, "Reduced motion") | Ruling 148(c): the OS `prefers-reduced-motion` setting is the one signal (`decisions.md:3085-3089`) | **Agrees** |
| Animate transform and opacity; exits faster than entrances; one continuous movement; no loops without meaning (`motion.md` rules 1-8) | Ruling 459, ruling 451 and the tracked `review-animations` / `improve-animations` skills | **Agrees** |
| Server-safe first render, with no `window`, `Date.now()` or `Math.random()` (`composition.md`) | Viberr is SSR on React Router 8 | **Agrees** |
| "A toast as the only confirmation of a foreground action" is a never (`SKILL.md`) | Ruling 451 caps toasts; in-place confirmation is the house pattern (`GlyphSwap`, `.copy-done`) | **Agrees** |

Run read-only over `app/`, the skill's `checklist.md` sweeps give the following raw hit
counts (sweeps overlap):

| Sweep | Hits |
|---|---|
| Focus and outline | 72 |
| Weight 600 or more | 193 |
| Uppercase and eyebrow | 111 |
| Raw colours | 234 |
| Gradients | 10 |
| `100vw` | 14 |
| Em dashes | 13,298 |

The checklist says "Each hit is a fix unless it is inside a string the user supplied". An
agent that ran it here in good faith would open hundreds of edits against tested rules.

## The three things "implement Arc here" can mean

| Path | Who it serves | Main rules in play | Repo change | Verdict |
|---|---|---|---|---|
| 1. A developer skill for work on Viberr's own code | People, Claude Code and Codex in this repo | `AGENTS.md:68`, rulings 166, 365, 451, 459, P16-UI-01, ruling 512 precedent | One adapted `SKILL.md` and a notice entry | Not as shipped; adapted, only if the owner wants it |
| 2. Arc components in `app/` | Viberr's users | Rulings 16, 148(c), 166, 365, 451, 457, 459, 499; UI porting rules | Rebuilds in `app/app.css` and `app/ui/*` | Rebuilds only; small yield |
| 3. Arc for the agents Viberr runs | Projects Viberr delivers | Rulings 39, 49, 51, 57, 176, 180, 183 | None; instance configuration | Workable today |

## Path 1: the skill for developers working on Viberr

**What the rulings say.**

- **The CLI ban covers the skill.** The `AGENTS.md:68-69` line and ruling 166 are
  unconditional. Later rulings reaffirm them: 511, 572, 573, 614 and 616
  (`decisions.md:9727, 9849, 9851, 9933, 9935`). A `registry:file` that writes only
  markdown is still `npx shadcn add`. The only mechanical check is the `package.json`
  denylist (`app/app.css.test.ts:634`). If the CLI wrote only `.claude/skills/arc/*` and
  `components.json`, every test would still pass, so review is the enforcement.
- **No ruling governs developer skills or developer MCP servers.** The precedent runs both
  ways:
  - `test-audit` was adapted, credited and recorded as ruling 512 (`decisions.md:9729`;
    `THIRD_PARTY_NOTICES.md:71-78`, "rewritten for this repository's harnesses, gates and
    vocabulary").
  - Six animation skills under `.agents/skills`, plus `.claude/skills/ponytail` and
    `.claude/skills/react-doctor`, were committed with no ruling and no notice entry.
- **Owners have used developer skills as read-only lenses whose findings became rulings:**
  453 `/apple-design`, 455 `/interface-review` and 459 `/better-ui`
  (`decisions.md:9548, 9558, 9574`). Their output went through the ruling process, not
  straight into `app/`.

**What already exists.**

- **Two layouts.** In one, the skills CLI keeps the copy in `.agents/skills/<name>`, with a
  symlink at `.claude/skills/<name>` and an entry in `skills-lock.json`. In the other, a
  real directory sits under `.claude/skills/`: `ponytail`, `react-doctor` and
  `test-audit`. `test-audit` is the precedent for a skill that did not come from the CLI.
- **`.agents/` is gitignored** (`.gitignore:16`). The six animation skills are tracked
  because they were force-added. A new `.agents/skills/arc` would be ignored unless
  force-added too.
- **`skills-lock.json` cannot describe Arc.** It is version 1, and every entry is
  `"sourceType": "github"`, so it has no field for a registry-item URL. It is also out of
  sync with disk (see Housekeeping).
- **No gate reads the skill folders.** `.oxlintrc.json:5-6` ignores `.agents/**` and
  `.claude/**`; vitest collects only `app/**` (`vitest.config.ts:26`); `.dockerignore:12`
  excludes `.claude`.
- **Governed product runs never see these folders.** Claude runs strip the checkout's
  `.claude` (`app/server/runtimes/skill-mount.server.ts:118`) and run with
  `settingSources: []` (ruling 180). Codex runs set `project_doc_max_bytes: 0`, turn off
  the CLI skills channel and set `plugins: false`
  (`app/server/runtimes/codex-runtime.server.ts:454-467, 479`). A developer skill reaches
  only developers' own sessions.
- **The guidance worth keeping already has homes.** Arc's motion rules restate ruling 459
  and the tracked `review-animations`, `improve-animations` and `emil-design-eng` skills.
  Its copy rule on dashes is already a test.

**What an adaptation would keep and replace.**

| Keep (aligned) | Replace with Viberr's rule |
|---|---|
| `motion.md` rules 1-9 and "Choosing a spring". Map Arc's `{ visualDuration, bounce }` springs onto `app/ui/spring.ts`'s `{ dampingRatio, response }` (`spring.smooth`, bounce 0, is `dampingRatio: 1`, `app/ui/spring.ts:26`), and easings onto `--ease-out` (`app/app.css:236`) | Install steps become "read the item at `https://uiarc.dev/components/<id>/markdown` or `get_component` as a reference, then rebuild it with classes in `app/app.css`" |
| `copy.md`: sentence case, verbs with objects, honest claims, empty-state and error patterns | `design.md` tokens, fonts, weights and radii become `app/app.css` `:root` tokens, Inter for both faces (ruling 365(a)) and the six radii |
| `composition.md`: React correctness (SSR-safe first render, stable keys, reserved widths) | `accessibility.md` "Focus without rings" becomes P16-UI-01's ring; keep the rest of that file |
| `responsive.md`: 390/768/1024/1440 checks, `min-width: 0`, tables scroll inside their card | `lucide-react` becomes the one `Icon` (`app/ui/icon.tsx`) |
| `components.md` as a catalogue to read, through the MCP's `get_component` | Skeleton, tooltip and sliding highlight are named as rejected (ruling 451); press values become ruling 459(d)'s |
| | Dialog, toast, calendar and icon families are named out of scope (rulings 16 and 166) |
| | `checklist.md` loses the font-weight, uppercase, raw-colour and focus sweeps, and keeps the rest |

What survives is mostly guidance the repository already carries, in its own vocabulary,
with tests behind it. The new value is narrow: a fast way into a well-documented
catalogue, through `get_component`, to read when a surface needs a pattern Viberr does not
yet have.

**Steps, if the owner wants it.**

1. Write the adapted skill as a real directory, `.claude/skills/arc-reference/SKILL.md`,
   in the `test-audit` layout. A distinct name keeps Arc's own `arc` skill from shadowing
   it for anyone who also installs Arc's version at user scope.
2. Give it a narrow description: when the owner or a developer asks to look at Arc, or a
   surface needs a pattern Viberr lacks. Do not trigger on generic UI work, which the
   tracked skills already cover.
3. Credit it in `THIRD_PARTY_NOTICES.md`. Record the source URL, retrieval date,
   `sha256` of `arc-skill.json`, the MIT notice, and a "rewritten for this repository"
   line like `:77-78`.
4. Record it as the next numbered ruling, as ruling 512 did for `test-audit`. It restates
   rulings 166, 365, 451 and 459, so the owner should see the wording.
5. For the MCP, each developer can run `claude mcp add --scope user --transport http
   arc https://uiarc.dev/api/mcp`, with nothing committed. A committed project
   `.mcp.json` has no precedent here, so that is an owner decision.

**What must not be done.**

- Run `npx shadcn add https://uiarc.dev/r/arc-skill.json` or `npx shadcn add
  @uiarc/arc-skill` here. Either one writes Arc's unadapted skill into this repository's
  `.claude/skills/arc/`, and may also write a `components.json`.
- Paste `INSTRUCTIONS.md` into `AGENTS.md` or `CLAUDE.md`, which the skill invites
  (`INSTRUCTIONS.md:3`). Its "Never" list contradicts P16-UI-01 and rulings 166 and 365.
- Hand-write a `skills-lock.json` entry with an invented `sourceType`.

**Cost.** No npm dependencies, no bundle bytes and no test changes. The risk is the
wording: no gate reads a skill, so review is the only check.

**Verdict.** Do not install the shipped skill here. An adapted reference skill is cheap
and harmless, but most of it repeats what the repository already says. Write it only if
the owner wants Arc as a standing reference. Otherwise, the per-developer MCP gives the
catalogue lookups with no repository change.

## Path 2: Arc components inside Viberr's own UI (`app/`)

**What the rulings say.**

| Rule | What it says | Where it is enforced |
|---|---|---|
| Ruling 166; `AGENTS.md:68` | No `npx shadcn add` and no pasted registry component; a registry is a design reference (`decisions.md:3684-3685`) | Prose and review, plus the `package.json` denylist (`app/app.css.test.ts:610-621, 634`), which fails `lucide-react` (77 Arc items) |
| UI porting rules | New CSS only "in clearly-marked appended sections of `app/app.css`. No Tailwind, no inline hex colors" (`decisions.md:140-141`) | Prose and review. `className={styles.x}` yields no class token, so the orphan gate never sees a CSS module (`app/app.css.test.ts:521, 527`). Vite would compile a `*.module.css` (no `css` option in `vite.config.ts`), and none exists in the repo |
| Token source | `app/app.css`'s `:root` is the only token source (`decisions.md:148`) | `var(--x)` must resolve to a declaration in `app/app.css` (`app/app.css.test.ts:136-142`) |
| Scale locks | Six font-size steps; exactly six `--radius-*` tokens; every `border-radius` a token or a small literal | `app/app.css.test.ts:2426-2434, 2476-2517` |
| Contrast | The WCAG sweep resolves hex, `var()`, `rgb[a]()` and `color-mix(in srgb)` from `:root` and `:root[data-theme="dark"]` | `app/app.css.test.ts:1400-1406, 1482-1491`. An oklch text colour, which `foundation.css` uses throughout, fails as unresolved |
| Focus ring | One app-wide ring on `--blue` | P16-UI-01, `app/app.css.test.ts:146-195`. Blind to a second sheet's `!important` |
| Excluded families | Rulings 16 and the one-`Icon` rule are why dialog, toast, calendar and icon families are out of scope (`decisions.md:3690-3692`) | Prose. F26 pins the dialog's motion (`app/app.css.test.ts:5111-5132`) |
| Ruling 148(c) | The OS setting is the one reduced-motion signal | CSS gates only (`app/app.css.test.ts:2738-2771, 3782-3799`). The `matchMedia` census counts literal calls (`:2305-2326`) |
| Ruling 451 | Sliding tabs, shimmer on cards, skeletons, tooltips and banner stacking rejected (`decisions.md:9542`) | Prose |
| Ruling 459(d) | Presses at .96 and .99 on `--ease-out`; hover changes colour, not position, on things hovered all day | F30 (`app/app.css.test.ts:4849`), F43 (`:4994-4997`), and every transform transition on `--ease-out` (`:3555-3566`) |
| Ruling 457 | Each route's gzip closure and `root.css` have ceilings; a raised ceiling carries its reason (`docs/development/performance.md:52-53`) | `npm run build && node scripts/measure-routes.mjs --check`, which is not part of `npm test` |
| Ruling 499 | A component-library site was adapted into Viberr's own code and credited; Pro items not recreated (`decisions.md:9703`) | Precedent; `THIRD_PARTY_NOTICES.md:7-12` |

**What already exists.** Viberr already has a home for most of Arc's families, each with
tests.

| Arc item | Viberr home | Status |
|---|---|---|
| `button` (press, loading and label swap) | `.btn` transform on `--ease-out` (`app/app.css:815`), `scale(.96)` press (`:824`); `.copy-done` `swap-in` (`:8306`); `GlyphSwap` and `CopyGlyph` (`app/ui/copy-glyph.tsx`) | Covered |
| `copy-button`, `action-swap`, `icon-morph` | `CopyGlyph` and `GlyphSwap` (ruling 451(c)) | Covered |
| `animated-counter` | `NumberTicker` (`app/ui/number-ticker.tsx`, ruling 366(f)); `@number-flow/react` on clock fields (`app/features/runtime/runs-panels.tsx:99`, ruling 524(b)) | Covered; a third would be a second definition |
| `segmented-control`, `tabs` | `.seg` groups; `RadioSeg` on Radix `ToggleGroup` (`app/ui/radio-seg.tsx:2`) | Sliding highlight rejected (ruling 451) |
| `dropdown-menu`, `context-menu`, `user-menu` | `menu-in .16s var(--ease-out)` from the trigger side (`app/app.css:679, 686`); the account menu on `radix-ui` | Covered |
| `dialog`, `drawer`, `bottom-sheet`, `confirm-morph` | Native `<dialog>` through `useDialog` (`app/ui/use-dialog.ts`), `pop-center` (`app/app.css:2782-2792`); `app/ui/use-sheet-drag.ts`; `app/ui/confirm-dialog.tsx` | Out of scope (rulings 16 and 166) |
| `toast`, `toast-stack` | `app/ui/toast.tsx`, `rise .3s var(--ease-out)` | Out of scope |
| `calendar`, `date-picker` | Dependency-free rebuild (`app/ui/calendar.tsx`, `app/ui/date-picker.tsx`) | Out of scope |
| `command-palette` | ⌘K palette, which deliberately does not animate (`app/app.css:2843-2852`) | Covered |
| `code-block`, `json-viewer` | `app/ui/code-view.tsx` on Shiki (ruling 363) | Covered |
| `skeleton`, `text-shimmer`, `tooltip` | `RoutePendingBar` after 220 ms; 248 native `title=` attributes | Rejected (ruling 451) |
| `reorderable-list`, drag | `@dnd-kit` with the in-house spring flight (`board-page.tsx:186-205`) | Covered |
| `page-header` | `PageTopbar` (`app/features/shell/page-topbar.tsx`, ruling 145) | Static layout only |
| `avatar-group` | Static overlap (`app/app.css:5312-5314`) | Judgment call, not a gap |
| `hover-card` | Nothing; 248 `title=` attributes | A new feature, not a port |
| `accordion`, `expandable-card` | Seven native `<details>`, where only the chevron rotates (`app/app.css:3092-3093`); house answer `reveal-down` on `.cap-mbody` (`app/app.css:3022-3026, 8260-8261`) | The one real gap |
| Charts (`line-chart`, `bar-chart`, `sparkline` and others) | No chart library | A new feature; out of this note's scope |

**Worked candidates.**

- **Disclosure bodies (first choice).** Give the occasional `<details>` bodies the
  `reveal-down` entrance `.cap-mbody` already uses: opacity plus `translateY(-4px)`, .16s
  on `--ease-out`, instant collapse, and a reduced-motion fade.
  - Candidates: `.cap-advisory` (`app/features/agents/agents-page.tsx:1097`),
    `.epic-archived` (`app/features/epics/epic-page.tsx:216`), and the connection-reach and
    controller-correction-evidence disclosures.
  - Leave out `.chg-file` (`app/features/task-detail/changes-panel.tsx:358`), which holds
    diffs people read.
  - Leave out the "Show more" `Collapsible`. Ruling 522 compensates scroll right after the
    fold (`app/ui/collapsible.tsx:141`), and ruling 561 showed that layout moving under a
    press loses the click.
  - This is the pattern Arc's `accordion` would teach, rebuilt in Viberr's own terms. No
    Arc source is needed.
- **Hover card (needs a feature ruling first).** Wrap Radix `HoverCard` (`radix-ui` is
  already a dependency, `package.json:45`) in `app/ui/hover-card.tsx`.
  - Style it with the floating-surface recipe (`app/app.css:661-688`).
  - Answer touch devices (`(hover: none)`), as Arc's own `responsive.md` asks.
  - Load it through `import()`. Ruling 616(c) declined a Radix menu at about 32 KB gzip
    because of its bytes (`decisions.md:9935`).

**The `motion` package, if it is ever proposed.** No test blocks it: it is on neither
the FORBIDDEN nor the PRIMITIVES list (`app/app.css.test.ts:610-624`). Every Arc component
read imports `motion/react`, the full entry. On Motion's published figures, that is about
34 KB gzip. This is an estimate, since nothing was installed or built. Against it:

- The root ceiling is 184,209 B. The largest single recorded raise is about 2.3 KB
  (`test-support/perf-budgets/bundle.json:2`).
- The closed dock's static module count is pinned at 21 with zero slack
  (`test-support/perf-budgets/controller.ts:25-27`).
- Every reduced-motion gate reads only `app/app.css`, so JS-driven motion would need a
  gate of its own.
- Motion's drag and layout features would duplicate `@dnd-kit` and `app/ui/spring.ts`.
- The precedents all go the other way. `NumberTicker` was written in "some forty lines"
  with no dependency (366(f)). Ruling 453 built its own spring on WAAPI. Ruling 499
  replaced a canvas library with CSS. Ruling 616(c) declined a permitted menu because of
  its bytes.

**What must not be done.**

- Run `npx shadcn add @uiarc/...`, add a `components.json`, or create `app/components/`.
- Paste Arc JSX or `*.module.css` files.
- Import `foundation.css`. Its global `outline: none !important` defeats the ring that
  P16-UI-01 tests for, and its tokens collide with seven of Viberr's.
- Use Arc's dialog, toast, calendar or icon items, or add a parallel Button, copy button
  or number ticker.
- Use oklch text colours, or add a literal `matchMedia` call.
- Import `motion` without a ruling.

**Cost.** A CSS-only candidate adds no dependency. It adds a few selectors to `root.css`,
whose ceiling is 47,072 B gzip (`bundle.json:3`). Raise the ceiling with its reason if a
build moves it, and add one owning test per new motion that no generic gate covers.

**Verdict.** Allowed as rebuilds, consistent with rulings 499, 511, 572, 573, 614 and 616.
Realistically one or two survivors, led by the disclosure reveal. Not recommended:
`motion`, CSS modules, `arc-foundation`, or any family named out of scope.

## Path 3: Arc for the agents Viberr runs on the projects it delivers

**What the rulings say.**

- **Ruling 166 governs Viberr's own `app/`** (`decisions.md:3679-3685`). Nothing in it
  governs a target project. Whether a delivered project installs Arc is that project's
  choice, and where its repository documents a UI stack, "the repository wins"
  (`decisions.md:704`).
- **Repository skills and MCP config never reach a governed run.** Ruling 49 (R18-3,
  `decisions.md:605-613`) governs the SDK catalogue out, with `strictMcpConfig: true`.
  Ruling 180 sets `settingSources: []` (`decisions.md:4091-4104`). The code is the strip at
  `app/server/runtimes/skill-mount.server.ts:101-141`, plus `strictMcpConfig` and
  `skipMcpDiscovery` (`app/server/runtimes/claude-runtime.server.ts:1341-1355`). So
  running `npx shadcn add …/arc-skill.json` in a *target* repository would not give
  Viberr's agents the skill. The files would ship in the PR (delivery stages with
  `git add -A`, `app/server/github/push-workspace.server.ts:851-866`) and stay invisible to
  later runs.
- **Ruling 39, amended by 176** (`decisions.md:483-492, 3955-3963`). Granting an MCP server
  is the whole authorization. Admin-marked write tools are withheld from runs that lack
  `execute-code-or-write-repo`.
- **Ruling 183** (`decisions.md:4191-4203`). Before any writer writes a `SKILL.md`, it
  refuses an empty body, a JSON-escaped body with literal `\n` and no real newline, and
  frontmatter that is not a YAML mapping.
- **Ruling 51** (`decisions.md:651-653`). Codex receives skills as prompt text within one
  shared 24,000-character budget (`app/server/files/skill-body.server.ts:40-41`).
- **Ruling 57** (`decisions.md:717-727`). Reviewer runs deliberately do not inherit the
  deliverer's skills.
- **An owner decision keeps a fresh instance an "honest empty slate"** with no seeded MCP
  servers (`app/server/org/org-seed.server.ts:259-264`).
- **Web egress is on by default.** This is recorded under "Owner decisions recorded outside
  this file" (`decisions.md:9978-9985`). Withholding `use-web-search-fetch` removes only
  `WebFetch` and `WebSearch` (`app/server/tasks/specialist-tool-policy.ts:81-89`). No host
  allowlist was found.

**How Arc's real artefacts fit.**

- **The MCP server fits the registry as it stands.**
  - An admin registers an HTTP server, and the registry probes it with a real `initialize`
    and `tools/list` over Streamable HTTP (`app/server/org/resources.server.ts:1588-1600`).
    Arc's server answered exactly that handshake.
  - With no credential, it mounts directly as `{type: "http", url}`
    (`app/server/tasks/specialist-mcp.server.ts:50, 393`;
    `app/server/runtimes/codex-runtime.server.ts:301`).
  - All five tools are read-only, so the reviewed write-tool list is `[]`.
  - Ruling 461's smoke test of a public docs MCP went through the gateway
    (`decisions.md:9608`), so no recorded test covers this direct path yet. The first save
    and test is that check.
- **The skill fits after two edits.**
  - Its frontmatter passes ruling 183, and `arc` passes the SDK name pattern
    (`skill-mount.server.ts:152-157`).
  - Its 675-character description is cut to 399 characters and "…"
    (`skill-mount.server.ts:521`). That loses everything after "components/arc/foundation.css
    (or the older r", including the "build or polish UI" trigger. Shorten it to under 400
    characters on purpose.
  - Its `SKILL.md` is 7,251 characters, which fits the Codex budget. The 12 reference files
    (68,084 characters together) do not, and need not be pasted. The MCP's `get_skill`
    serves each one on demand.
  - Pasting into the `SKILL.md` editor goes through `saveSkill`, which validates
    (`resources.server.ts:2475`). GitHub import would not (see Housekeeping).
- **The MCP server's instructions point agents at `get_install_command`.** That runs the
  shadcn CLI in the *target* checkout. Under ruling 166's scope, that is the target
  project's call. An agent holding `execute-code-or-write-repo` can do it, because egress is
  open.

**Steps (instance configuration, no code).**

1. As org admin, go to Instance settings, then Agent resources, then New MCP server:
   - name `arc`, transport HTTP, URL `https://uiarc.dev/api/mcp`;
   - credential blank;
   - Save & test;
   - record write tools as `[]`.
2. Create skill `arc` by pasting `SKILL.md`. Shorten its description below 400 characters,
   and add one line saying that a UI stack the repository already documents takes
   precedence. Its pointers to the sibling files can stay, since `get_skill` serves them.
3. A project admin with `manage-agents` grants both on the developer or UI agent's
   profile (`app/features/agents/agent-profile-actions.server.ts:302-305`). Grant them on
   the reviewer profile too if reviewers should judge Arc usage (ruling 57).
4. Decide deliberately before granting the MCP to the controller. The controller receives
   org MCP grants (`app/server/controller/controller-run.server.ts:764-765, 780`) even
   though its `WebFetch` and `WebSearch` are denied (`:790`).

**What must not be done.**

- Install `arc-skill.json` into a target repository and expect Viberr's agents to pick it
  up.
- Seed Arc in `org-seed.server.ts`.
- Make it a built-in like the Humanizer skill (ruling 502), which never enters the store and
  so stays hidden from grant disclosure.

**Cost.** No code, no dependencies and no bundle bytes. Each run spends some tokens on the
skill listing, and on Codex the skill takes part of the shared budget.

**Verdict.** Workable today with no code. It pays off only for delivered projects built on
React that accept Arc's prerequisites (`components.json`, `motion`, `lucide-react`, CSS
modules). Whether to configure it is a per-instance product decision, not a ruling.

## Recommendation

Ranked:

1. **Path 3, if delivered projects build React UIs.** It is the only route where Arc is used
   as designed. It needs no code and no ruling.
2. **Path 2, a read-only sweep**, expecting one or two survivors, led by the disclosure
   reveal. The sweep needs no ruling. The shortlist does.
3. **Path 1, an adapted reference skill**, only if the owner wants Arc as a standing
   reference. Otherwise, each developer can add the MCP at user scope.
4. **Not recommended:**
   - the shipped skill in this repository;
   - `npx shadcn add` of anything;
   - `arc-foundation`, CSS modules, `motion` or `lucide-react` in `app/`.

**Can be done without an owner ruling.**

- Reading Arc's pages, registry and MCP as reference, which is what ruling 166 permits.
- A per-developer MCP at user scope.
- An org admin configuring Arc on an instance.
- The read-only sweep.
- Fixes that make the tree match rulings it already has, such as ruling 183's check in
  GitHub import ("EVERY writer", `decisions.md:4196`).

**Goes to the owner as the next ruling.** The highest ruling today is 616
(`decisions.md:9935`), and 615 is absent, so the next is 617 or whatever is free at merge
time.

- Committing an adapted skill and its notice entry (precedent: ruling 512).
- A committed project `.mcp.json`.
- The Path 2 shortlist, with each adoption's tests and budget figures.
- A hover card, which is a new feature.
- Any server-side import-from-URL door for skills.
- Adding `motion`.

**Would narrow or reverse an existing ruling.** Each of these must be raised openly and
re-ruled (`AGENTS.md:62`), never done silently:

- the shadcn CLI or pasted registry source (ruling 166);
- removing the focus ring (P16-UI-01);
- Geist as display face (ruling 365(a));
- CSS modules or a second authored stylesheet (UI porting rules);
- `arc-foundation` tokens or a widened scale lock (`decisions.md:148`);
- an in-app reduced-motion toggle (ruling 148(c));
- Arc dialog, toast, calendar or icon items (rulings 16 and 166);
- sliding tabs, tooltips or skeletons (ruling 451).

## Housekeeping found along the way

- **Dangling skill symlinks.** Nine of the fifteen `.claude/skills` symlinks point at
  missing targets: `better-accessibility`, `better-colors`, `better-interface`,
  `better-layout`, `better-typography`, `better-ui`, `better-writing`, `break` and
  `interface-review`. Their targets under `.agents/skills` were never committed
  (`.gitignore:16`). `better-ui` and `interface-review` were the lenses behind rulings 459
  and 455.
- **`skills-lock.json` drift.** It lists exactly those nine missing skills and none of the
  six tracked ones. Fix this before adding another skill beside them.
- **Missing notice entries.** `THIRD_PARTY_NOTICES.md` has none for the six tracked
  animation skills, `ponytail` or `react-doctor`.
- **GitHub skill import skips ruling 183's check** on both write paths
  (`app/server/org/store-files.server.ts:907, 1014`). Its docstring's "no public
  unauthenticated fallback" (`:56-59`) is contradicted at `:753-754`.
- **The focus-ring test is blind to a second stylesheet.** P16-UI-01 reads only
  `app/app.css`. A sheet loaded after it with `outline: none !important`, as
  `foundation.css` has, would pass the test and remove the ring. The UI porting rules
  forbid such a sheet; no test does.
- **Ruling 166(c) is not enforced.** `app/features/shell/user-menu-panel.tsx:3` imports
  `radix-ui` outside `app/ui`, and `@base-ui/react` is declared (`package.json:29`) but
  imported nowhere in `app/`.
- **`CLASSLESS_BY_DESIGN`** survives only in a comment (`app/features/copy-ban.test.ts:907`),
  though ruling 166 says it "stays capped" (`decisions.md:3687`).
- **The bundle gate is missing from `CLAUDE.md:5`.** The doc lists lint, typecheck and test,
  and leaves out `npm run build && node scripts/measure-routes.mjs --check`
  (`docs/development/contributing.md:38-39`). Separately, `contributing.md:43` says a moved
  budget "fails `npm test`", which it does not.
- **The `matchMedia` census counts literal calls only** (`app/app.css.test.ts:2315`).
  `NumberTicker`'s `window.matchMedia?.(REDUCED_MOTION)` (`app/ui/number-ticker.tsx:34`) is
  an uncounted sixth read.
- **No e2e spec emulates reduced motion.** Neither `e2e/` nor `playwright.config.ts` uses
  `reducedMotion` or `emulateMedia`.

## Open questions

- Whether delivered projects want Arc at all. Path 3 pays off only for React projects that
  accept `components.json`, `motion`, `lucide-react` and CSS modules.
- Whether the owner wants Arc as a standing reference for Viberr's own UI (Path 1's
  adapted skill), or only as an occasional read (the per-developer MCP).
- Whether the 111 uppercase and eyebrow sites and the weight-600 titles are house style to
  keep or debt Arc's copy rules have surfaced. That is a design question in its own right,
  separate from adopting Arc.
- The real byte cost of `motion/react` in Viberr's build. The 34 KB figure is an estimate,
  and no build was run.
- How the shadcn CLI treats `arc-skill` in a project with no `components.json`: an
  `init` prompt, or a direct write. This is CLI behaviour, and it does not change the
  recommendation.
- Arc's licence page is a draft "pending review". Recheck it before any adaptation is
  credited.

## Sources

Fetched 2026-10-01 with a plain HTTP client:

- https://uiarc.dev/r/arc-skill.json (sha256 `847772d5261b3534e4eb5dd9dd34ce1c8dcc333df65b9f32c8fea4d7fadbab43`; its `SKILL.md`, decoded: `29a2078a6a2f5bc9e13cedfee72407e123e166c3e17249aed7f58b611d51c492`)
- https://uiarc.dev/r/arc-foundation.json (sha256 `d2c069638ede51252811a38e62170fc6db92bc8bb8248bdc04b8b36ebd318bcc`)
- https://uiarc.dev/r/registry.json, and https://uiarc.dev/r/button.json, `segmented-control.json`, `dialog.json`, `animated-counter.json`
- https://uiarc.dev/llms.txt
- https://uiarc.dev/license
- https://uiarc.dev/api/mcp (`initialize` and `tools/list`)
- https://ui.shadcn.com/docs/registry/registry-item-json (the meaning of `~` in `target`)

Found through search, not read here:

- https://github.com/kuratlielia/arc-library (Arc's public repository)
- https://github.com/shadcn-ui/ui/pull/12055 (the `@uiarc` registry directory PR)

Repository evidence is cited inline as `path:line` against `28c8a07`.
