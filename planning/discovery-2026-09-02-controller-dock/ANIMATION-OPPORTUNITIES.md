# Animation opportunities for the controller dock (find-animation-opportunities report)

Scope: the new dock only. The rest of the app had a full motion pass in pass 30 and the
UI-skills pass on 2026-08-26; nothing there is re-litigated here. Tokens used are the
sheet's own: `--ease-out: cubic-bezier(.23, 1, .32, 1)`, the `.1s/.12s/.15s/.16s/.18s/.2s`
duration family, `--shadow-lift`, `--shadow-pop`.

## Part 1: opportunities (ordered by leverage)

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `controller-dock.tsx` panel open/close | (new) would appear instantly | Spatial consistency: the panel belongs to its trigger | Occasional | `transform-origin: bottom right`; enter from `opacity: 0; transform: translateY(8px) scale(.97)` over `.18s var(--ease-out)`; exit to `opacity: 0; translateY(6px) scale(.98)` over `.12s var(--ease-out)` (exit faster than enter); Escape close is instant (keyboard-initiated); reduced motion: opacity only, `.12s ease` |
| 2 | `.dock-fab` press | (new) no press state | Feedback | Tens/day | `:active { transform: scale(.94) }`, `transition: transform .1s var(--ease-out)`; hover lift only under `@media (hover: hover) and (pointer: fine)` |
| 3 | `.dock-msg` (a reply arriving while the panel is open) | text block would teleport in | Preventing a jarring change | Occasional | mount-only: from `opacity: 0; transform: translateY(4px)` over `.2s var(--ease-out)`; gated on the transcript having settled so history never animates; reduced motion: opacity only |
| 4 | `.dock-fab` while a turn works | nothing says the controller is busy once the panel is closed | State indication | Continuous while working | reuse `.live-dot` (`livePulse`), static under reduced motion |
| 5 | mobile sheet (≤ 720 px) | would pop | Spatial consistency | Occasional | `translateY(100%)` ↔ `0`, `.22s var(--ease-out)`, exit along the same edge; reduced motion: fade |

## Part 2: rejected candidates

- Transcript stagger on open. **Rejected: functional text the person is about to read; a
  cascade delays reading and adds nothing.**
- Smooth `scrollIntoView` to the newest message. **Rejected: functional; the instant jump
  the page already does is right.**
- Hover highlight on messages. **Rejected: tens of times per session on non-interactive
  content; decoration on functional UI.**
- A shimmer or typing indicator on the working row. **Rejected: the dot plus the sentence
  already carry the state; a second animation competes with it.**
- Animating the scope pill when the context changes on navigation. **Rejected: navigation
  is frequent; the crumb trail does not animate either, and the panel's own contents
  change at the same moment.**
- A keyboard shortcut with an animated open. **Rejected outright: no shortcut is added; if
  one ever is, it must open without animation.**

## Part 3: verdict

The dock needs very little motion: an origin-aware open and close, press feedback, and a
soft landing for a reply that arrives while the panel is up. Everything else on it is
reading and typing, which argues for stillness. The highest-leverage row is #1: without an
origin-aware open the panel reads as a modal that forgot its scrim. Handoff:
`improve-animations plan <row>` turns any row into an implementation plan; here they are
implemented directly in `app.css`'s appended dock section.
