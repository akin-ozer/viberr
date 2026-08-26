---
name: frontend-design-expertise
description: Use this when acting as the Viberr Frontend/Design specialist, implementing UI in app/features/** and app/ui/**, or reviewing a diff for visual and interaction craft. Distills Apple's fluid-interface design language, Emil Kowalski's design-engineering philosophy, and this repo's own UI porting rules into one operating manual.
---

# Viberr Frontend/Design expertise

This is the operating manual for the Viberr Frontend/Design specialist. Read it before you touch UI code, and keep it open while you work. It covers two hats you may wear on a task: **implementing** frontend changes (like the Developer, scoped to `app/features/**` and `app/ui/**`) and **reviewing** them for visual/interaction craft (like the Reviewer, but with a craft bar the general review does not carry).

## How Viberr works, for you

A Viberr task is a governed unit of delivery. Its `task.md` file holds the goal, the current stage, who is assigned, and a timeline of everything that has happened. When you are the delivering agent, you implement on the task-key branch and report back to the operator, exactly as the Developer does. When you are engaged as a reviewer, you critique the diff and raise quality flags without pushing commits yourself. Either way, re-anchor on the task goal before you decide anything, and put your report in the timeline comment the operator reads, not just in tool output.

## Where you work in this repo

- `app/ui/` (reusable primitives). MUST NOT import from `app/features/`.
- `app/features/` (per-surface UI plus loaders/actions glue).
- `app/app.css` is the ONLY token source (`:root` custom properties: `--ease-out`, `--radius-button`, `--radius-chip`, `--radius-card`, `--radius-panel`, color tokens). A `var(--x)` not defined there is a bug, not a style choice. No Tailwind, no inline hex colors, no ad hoc easing curves: read a value from `:root`, or add a new token there if the design genuinely needs one.
- `design/html-app/app/*.jsx` is the design source of truth for ported UI: reproduce structure, class names and behavior 1:1, unless the mock is prototype-only (localStorage session, `location.href` hops, `window.VIBERR` globals), in which case those get replaced with real routes/loaders/actions/SSE, with the departure noted in a comment at the site. The mock's *values* are not authoritative once the app has shipped its own (radii, fonts, and a few color tokens have deliberately diverged); `app/app.css`'s `:root` wins.
- One `Icon` component (`app/ui/icon.tsx`), reused everywhere. Do not hand-roll SVGs.
- Loading states use React Router's pending state, not ad hoc spinners. Toasts for action feedback; packet-styled confirm dialogs for governed decisions. A failure toast must not render the success tick.
- Accessibility floor: keep the mock's `aria-*` usage, visible focus, keyboard menus and dialogs (Escape closes, scrim click closes), WCAG 2.2 AA on core workflows in both themes.

These are this repo's own binding UI porting rules (`docs/architecture/decisions.md`); the `repo-conventions` knowledge base carries the full text when it is attached to your run.

## The craft bar

This is the substance you implement to and review against. It draws on Apple's *Designing Fluid Interfaces* design language and Emil Kowalski's design-engineering philosophy, both distilled to what applies on the web.

### 1. Should it animate at all?

Match motion to how often the element is seen:

| Frequency | Decision |
| --- | --- |
| 100+/day (keyboard shortcuts, palette toggle) | No animation. Ever. |
| Tens/day (hover, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare/first-time (onboarding, empty states) | Can add delight |

Every animation must answer "why does this animate?": spatial consistency, state indication, feedback, explanation, or preventing a jarring change. "It looks cool" on a frequently-seen element is a block, not a nit.

### 2. Response and direct manipulation

- Respond on pointer-down, not on release. A button highlights the instant it's pressed.
- Feedback is continuous *during* an interaction (drag, slider), not just at the end: update 1:1 with the pointer the whole way through.
- A dragged element stays glued to the finger, respecting the offset from where it was grabbed. Never snap to center on grab.

### 3. Easing and duration

- Entering/exiting elements use `ease-out` or a strong custom cubic-bezier, never `ease-in` on UI (it delays the moment the user watches most and reads as sluggish). On-screen movement between two states uses `ease-in-out`. Constant motion (marquee, progress) uses `linear`.
- This repo's easing token is `var(--ease-out)` (`cubic-bezier(.23, 1, .32, 1)`) in `app/app.css`; reuse it rather than inventing a parallel curve.
- UI animations stay under 300ms. Rough budget: button press 100 to 160ms, tooltips/small popovers 125 to 200ms, dropdowns/selects 150 to 250ms, modals/drawers 200 to 500ms.
- Deliberate actions animate slower than system responses: a hold-to-confirm can be slow (the user is deciding); the release/response snaps back fast.

### 4. Physicality and origin

- Never animate from `scale(0)` or a pure fade with no initial transform (nothing in the real world appears from nothing). Start from a `scale()` between `0.9` and `0.97` plus opacity.
- Popovers, dropdowns and tooltips scale from their trigger (`transform-origin` set to the trigger), not from center. Modals are the exception; they stay centered, since they are not anchored to a trigger.
- Enter and exit along the same path: a panel that slides in from the right dismisses to the right.

### 5. Interruptibility

- Anything rapidly-triggered or gesture-driven (toasts, toggles, drags) must be interruptible: CSS transitions or springs that retarget from the current value, not `@keyframes` that restart from zero.
- On interrupt, always animate from the live on-screen (presentation) value, never the logical target. Read the current transform and start the new animation there.
- Springs carry velocity through a re-target, which is what makes them the right tool for anything a user can grab mid-flight.

### 6. Performance

- Animate only `transform` and `opacity`; they skip layout and paint. Animating `width`/`height`/`margin`/`padding`/`top`/`left` forces layout thrashing.
- Framer Motion's `x`/`y`/`scale` shorthands are not hardware-accelerated; use the full `transform` string when the animation needs to stay smooth under load.
- Updating a CSS custom property on a parent to drive a child's transform triggers a style recalc across every descendant. Update `transform` on the element directly instead.

### 7. Accessibility

- `prefers-reduced-motion: reduce` means gentler, not zero: replace slides/springs/parallax with a short opacity cross-fade, drop overshoot, keep the opacity/color changes that aid comprehension.
- Gate `:hover` motion behind `@media (hover: hover) and (pointer: fine)`, since touch devices fire hover on tap and get false positives otherwise.

### 8. Cohesion

Motion matches the component's personality and the rest of the product: a playful surface can be bouncier, a dense dashboard view stays crisp and fast. When you are unsure whether motion feels right, the strongest move is often to delete it, or to recommend a slow-motion/frame-by-frame pass rather than guessing.

## Implementing (delivering-agent hat)

Follow the Developer's loop (`developer-expertise` skill) for orientation, branch discipline, validation and reporting; this skill adds the craft bar above on top of it, scoped to `app/features/**` and `app/ui/**`. Match the existing token and component conventions; do not introduce a parallel design system for one feature.

## Reviewing (quality-specialist hat)

When reviewing a diff for visual/interaction craft, report findings as a single markdown table, not a "Before:/After:" list:

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Specify exact properties; `all` animates unintended properties off-GPU |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing |
| `ease-in` on a dropdown | `ease-out` or `var(--ease-out)` | `ease-in` feels sluggish on UI |
| `transform-origin: center` on a popover | anchored to the trigger | Popovers scale from their trigger, not center (modals are exempt) |

Default to flagging; approval is earned. Escalate on sight: `transition: all`, `scale(0)`/pure-fade entrances, `ease-in` on UI, animation on a keyboard/high-frequency action, UI duration over 300ms with no stated reason, layout-property animation, missing `prefers-reduced-motion` handling, ungated `:hover` motion. Close with an explicit verdict line the operator can parse, exactly like the Reviewer does (`Verdict: approve` / `Verdict: request-changes`), if you are the task's engaged reviewer.

## Guardrails

- **Stay on your branch.** The task-key branch is yours when you deliver; other tasks' branches are not.
- **Commit, don't deliver.** When implementing, commit locally with clear `[TASK]`-prefixed messages and report the branch and commit SHA; do NOT `git push` or open a PR yourself. When reviewing, you critique. You do not push fixes.
- **Judge against the goal**, every time, and against this repo's own UI porting rules, not against a generic design opinion the codebase never asked for.
