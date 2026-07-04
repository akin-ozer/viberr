# Porting spec — `tweaks-panel.jsx`

Source: `design/html-app/app/tweaks-panel.jsx` (541 lines)
Status: **RECOMMEND: DO NOT PORT into the product app.** Read "Purpose & entry points" and "Porting notes" before scheduling any work. The rest of this spec is exhaustive so the decision (and any dev-tooling salvage) can be made without opening the mock file.

---

## 1. Purpose & entry points

### What this file actually is

This is **not a Viberr product surface**. It is the *prototyping harness's* "Tweaks" overlay — a floating, draggable dev panel (bottom-right, frosted-glass, always-light-themed) that lets a designer live-tweak design tokens (font size, colors, density, booleans, etc.) of a prototype running inside the "omelette" host tool. The first line of the file is:

```
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)
```

i.e. it deliberately opts out of the Viberr design system. It uses its own `twk-*` class namespace with hardcoded hex/px values injected via an inline `<style>` tag — none of these classes exist in `viberr.css`, so the "CSS class names are the contract" rule **does not apply** to this file.

### Where it mounts: nowhere

- **No HTML entry file loads it.** `Viberr Home.html`, `Viberr Login.html`, and `Viberr Operator Workspace.html` each list their `<script>` includes explicitly; `tweaks-panel.jsx` is absent from all three.
- **No component uses it.** A repo-wide grep for `TweaksPanel`, `useTweaks`, `Tweak*`, `tweakchange`, `EDITMODE`, `edit_mode`, `omelette` finds only one reference outside this file: a **stale load-order comment** at `home.jsx:2` ("Loads after data.js + ui.jsx … + tweaks-panel.jsx"). Nothing in `home.jsx` (or anywhere else) actually calls any export.
- It exports everything to `window` at the bottom of the file (prototype "module system"):

```js
Object.assign(window, {
  useTweaks, TweaksPanel, TweakSection, TweakRow,
  TweakSlider, TweakToggle, TweakRadio, TweakSelect,
  TweakText, TweakNumber, TweakColor, TweakButton,
});
```

### The host protocol (dev-tool infrastructure, not app behavior)

The panel assumes the prototype runs in an **iframe inside a host tool** ("omelette"). Communication is `window.parent.postMessage` / `window.addEventListener('message')`:

| Direction | Message type | When | Payload |
|---|---|---|---|
| panel → host | `__edit_mode_available` | On mount (after registering its own listener, deliberately in that order so the host's activate can't race the handler) | `{ type }` only |
| host → panel | `__activate_edit_mode` | Host toolbar toggle on | opens panel (`setOpen(true)`) |
| host → panel | `__deactivate_edit_mode` | Host toolbar toggle off (also echoed back after a dismiss) | closes panel |
| panel → host | `__edit_mode_dismissed` | User clicks the ✕ button | host flips its toolbar toggle off, then echoes `__deactivate_edit_mode`, which is what actually hides the panel (the ✕ also optimistically `setOpen(false)` locally) |
| panel → host | `__edit_mode_set_keys` | Every `setTweak(...)` call | `{ type, edits }` where `edits` is a partial key→value object; **the host rewrites the `/*EDITMODE-BEGIN*/…/*EDITMODE-END*/` JSON block in the prototype's source file on disk** |

Plus one same-window event: `setTweak` dispatches `new CustomEvent('tweakchange', { detail: edits })` on `window` so sibling in-page listeners (the comment cites "deck-stage rail thumbnails" — part of the host tool, not present anywhere in this repo) can react. No file in `design/html-app/` listens for `tweakchange`.

### Persistence model

`useTweaks(defaults)` is plain `React.useState` seeded from a `TWEAK_DEFAULTS` literal that the consuming prototype defines between `/*EDITMODE-BEGIN*/` and `/*EDITMODE-END*/` comment markers. Persistence happens **entirely on the host side** (host rewrites that JSON block in the source file). There is no localStorage, no cookie, no server call. If the host is absent (file opened directly in a browser), `postMessage` to `window.parent` is a harmless no-op (parent === self), the panel simply never opens (nothing sends `__activate_edit_mode`), and values are session-ephemeral.

---

## 2. Component tree

All top-level; no nesting hierarchy beyond "controls are rendered as children of `TweaksPanel`":

- `__TWEAKS_STYLE` — const string of scoped CSS, injected as `<style>{__TWEAKS_STYLE}</style>` inside the panel render (only present in DOM while panel is open).
- `useTweaks(defaults)` — hook; returns `[values, setTweak]`. `setTweak('key', v)` **or** `setTweak({ key: v, ... })` (object form supported so a useState-style call doesn't persist a `"[object Object]"` key). Merges into state, posts `__edit_mode_set_keys`, dispatches `tweakchange`.
- `TweaksPanel({ title = 'Tweaks', children })` — floating draggable shell; owns open/closed state and the host protocol; renders `null` when closed.
- `TweakSection({ label, children })` — uppercase section header (`twk-sect`) + passthrough children.
- `TweakRow({ label, value, children, inline = false })` — label row wrapper; `inline` switches to horizontal layout (`twk-row twk-row-h`); optional right-aligned value readout (`twk-val`), rendered only when `value != null`.
- `TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = '', onChange })` — `<input type="range">` with `${value}${unit}` readout in the row label.
- `TweakToggle({ label, value, onChange })` — iOS-style switch, `role="switch"`, `aria-checked`, green `#34c759` when on.
- `TweakRadio({ label, value, options, onChange })` — segmented control with animated thumb + pointer-drag scrubbing; **auto-falls back to `TweakSelect`** when labels don't fit (see §4).
- `TweakSelect({ label, value, options, onChange })` — native `<select class="twk-field">`; options are strings or `{ value, label }`. Emits **strings** (native select behavior).
- `TweakText({ label, value, placeholder, onChange })` — text input.
- `TweakNumber({ label, value, min, max, step = 1, unit = '', onChange })` — number field with a scrub-draggable label (Photoshop-style `ew-resize` scrubbing).
- `__twkIsLight(hex)` — relative-luminance check (`r*299 + g*587 + b*114 > 148000`); hex-only (`#rgb`/`#rrggbb`); anything unparseable → `true` ("light"). Used to pick checkmark color on color chips.
- `__TwkCheck({ light })` — 14×14 checkmark SVG; stroke `rgba(0,0,0,.78)` on light swatches, `#fff` on dark.
- `TweakColor({ label, value, options, onChange })` — curated color/palette chip picker; falls back to native `<input type="color">` when no `options` given.
- `TweakButton({ label, onClick, secondary = false })` — action button, dark primary or light secondary.

---

## 3. Data consumed

**None of the app's data.** Verified:

- Imports nothing from `ui.jsx` (no `Icon`, `Avatar`, `Pill`, toasts — it draws its own ✕ character and its own SVG checkmark inline).
- Reads nothing from `data.js` / `window.VIBERR`.
- Reads nothing from localStorage / session / hash route.
- Its only inputs are: (a) the `defaults` object handed to `useTweaks` by a consuming prototype (none exist in this repo), and (b) the host `postMessage` protocol described in §1.
- Environment couplings: `window.parent`, `window.innerWidth/innerHeight`, `ResizeObserver` (with `window.resize` fallback), and CSS var `--dc-inv-zoom` (host-provided inverse-zoom factor so the panel stays natural-size when the host scales the prototype iframe; defaults to 1).

**In the real app there is no projection query, file, session field, or env var that feeds this component.** If a dev-tools variant were ever wanted, its state would be dev-local (e.g. localStorage or a dev-only endpoint) — see §7.

---

## 4. UI states & interactions

### Panel shell (`TweaksPanel`)

- **Closed (default):** renders `null`. Opens only on receipt of `__activate_edit_mode`.
- **Open:** fixed bottom-right, 280px wide, `max-height: calc(100vh - 32px)`, `z-index: 2147483646`, scrollable body (thin styled scrollbar). Marked `data-omelette-chrome=""` (host uses this to exclude the panel from screenshots/captures).
- **Verbatim shell JSX:**

```jsx
<>
  <style>{__TWEAKS_STYLE}</style>
  <div ref={dragRef} className="twk-panel" data-omelette-chrome=""
       style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}>
    <div className="twk-hd" onMouseDown={onDragStart}>
      <b>{title}</b>
      <button className="twk-x" aria-label="Close tweaks"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={dismiss}>✕</button>
    </div>
    <div className="twk-body">
      {children}
    </div>
  </div>
</>
```

- **Drag:** header (`twk-hd`, `cursor:move`) starts a mouse drag (`mousemove`/`mouseup` on `window`); position is tracked as *right/bottom offsets* (not left/top) in a ref, applied as inline `style.right/bottom` px. Offsets are clamped to a 16px viewport padding on every move.
- **Clamp-on-resize:** while open, a `ResizeObserver` on `document.documentElement` (fallback: `window` `resize` listener when `ResizeObserver` is undefined) re-clamps so the panel can never end up off-screen.
- **Close:** ✕ button — `aria-label="Close tweaks"`, `onMouseDown` stops propagation so clicking it doesn't start a drag. Calls `dismiss()` = `setOpen(false)` + post `__edit_mode_dismissed`.
- **No keyboard handling** (no Escape-to-close, no focus trap) — it's a dev tool.
- User-visible copy: title default **"Tweaks"**; ✕ glyph; everything else comes from consumer-supplied labels.

### `TweakSlider`
Row label left, `${value}${unit}` readout right (tabular-nums, e.g. "16px"). Range input; `onChange(Number(e.target.value))` — always numeric.

### `TweakToggle`
`<button type="button" class="twk-toggle" data-on="1|0" role="switch" aria-checked={!!value}>` with an `<i/>` knob; click → `onChange(!value)`. Green track when on.

### `TweakRadio` (segmented control)
- Options: strings/numbers/booleans, or `{ value, label }`.
- **Auto-fallback rule (important):** computes max label length; segments fit only if `maxLen <= { 2: 16, 3: 10 }[options.length]` — i.e. 2 options up to 16 chars each, 3 options up to 10 chars, and **any other option count (1, 4+) always falls back** to `TweakSelect`. The fallback wraps `onChange` in a resolver that maps the select's string back to the original option so types are preserved (numbers/booleans survive):

```jsx
const resolve = (s) => {
  const m = options.find((o) => String(typeof o === 'object' ? o.value : o) === s);
  return m === undefined ? s : typeof m === 'object' ? m.value : m;
};
return <TweakSelect label={label} value={value} options={options}
                    onChange={(s) => onChange(resolve(s))} />;
```

- **Segment path markup (verbatim):**

```jsx
<div ref={trackRef} role="radiogroup" onPointerDown={onPointerDown}
     className={dragging ? 'twk-seg dragging' : 'twk-seg'}>
  <div className="twk-seg-thumb"
       style={{ left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
                width: `calc((100% - 4px) / ${n})` }} />
  {opts.map((o) => (
    <button key={o.value} type="button" role="radio" aria-checked={o.value === value}>
      {o.label}
    </button>
  ))}
</div>
```

- **Scrubbing:** `pointerdown` on the track selects the segment under the pointer and attaches window `pointermove`/`pointerup`; dragging across segments fires `onChange` per segment crossed. The current value is mirrored into a ref (`valueRef`) so the long-lived move handler doesn't fire `onChange` redundantly from a stale closure. While dragging, class `twk-seg dragging` disables the thumb's CSS transition so it tracks 1:1.
- Thumb position is pure CSS calc from the active index — no measurement.
- Note: the buttons themselves have **no onClick**; all selection goes through the track's pointer handler. `idx` clamps to 0 when value isn't found (`Math.max(0, findIndex...)`).

### `TweakSelect`
Native select styled as `twk-field` with an inline data-URI chevron. **Emits raw strings** — consumers needing typed values must go through `TweakRadio`'s fallback or resolve themselves.

### `TweakText`
Plain controlled text input, `twk-field`.

### `TweakNumber`
- Layout: `[label][input][unit?]` inside a bordered pill (`twk-num`); input is right-aligned, spin buttons suppressed.
- **Label scrubbing:** `pointerdown` on the label (`cursor:ew-resize`, `e.preventDefault()`) starts a drag where each horizontal pixel = one `step`; the result is snapped to the step grid and rounded to the step's decimal places (`Number(snapped.toFixed(decimals))`), then clamped to `[min, max]` (each bound optional, `!= null` checks).
- Direct typing: `onChange(clamp(Number(e.target.value)))`.

### `TweakColor`
- **No options →** back-compat native picker: `<input type="color" class="twk-swatch">`, label row inline.
- **With options →** chip radiogroup. Each option is one hex string **or an array of 1–5 hex strings** (a palette). Chip anatomy: solid `background: hero` (colors[0]); if the palette has more colors, up to 4 of the rest render as a stacked column (`<span><i/>…</span>`) occupying the right 34% of the chip; selected chip gets a 1.5px dark ring (`data-on="1"`) and an overlaid checkmark whose color is chosen by `__twkIsLight(hero)`.
- Selection comparison: `String(JSON.stringify(o)).toLowerCase()` on both sides — case-insensitive (native color inputs emit lowercase hex) and shape-exact (string vs array of same color are different options). The `String()` wrapper guards `JSON.stringify(undefined)` returning primitive `undefined`.
- `onChange` re-emits the option **in the shape it was declared** (string stays string, array stays array — the stored tweak value for a palette is the whole array).
- **Verbatim chip markup:**

```jsx
<div className="twk-chips" role="radiogroup">
  {options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return (
      <button key={i} type="button" className="twk-chip" role="radio"
              aria-checked={on} data-on={on ? '1' : '0'}
              aria-label={colors.join(', ')} title={colors.join(' · ')}
              style={{ background: hero }}
              onClick={() => onChange(o)}>
        {sup.length > 0 && (
          <span>
            {sup.map((c, j) => <i key={j} style={{ background: c }} />)}
          </span>
        )}
        {on && <__TwkCheck light={__twkIsLight(hero)} />}
      </button>
    );
  })}
</div>
```

### `TweakButton`
`twk-btn` (dark, white text) or `twk-btn secondary` (translucent). Fires `onClick` verbatim.

### Aria summary
- Panel ✕: `aria-label="Close tweaks"`.
- Toggle: `role="switch"` + `aria-checked`.
- Radio track & color chips: `role="radiogroup"` containing `role="radio"` + `aria-checked` buttons.
- Checkmark SVG: `aria-hidden="true"`. Color chips: `aria-label` = comma-joined colors, `title` = " · "-joined colors.
- No dialogs, menus, toasts, packet cards, or log lines exist in this file.

---

## 5. Events / mutations produced

**None that map to real app actions.** The complete outbound surface is:

1. `window.parent.postMessage({ type: '__edit_mode_available' }, '*')` — once on mount.
2. `window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*')` — per tweak change; the omelette host persists `edits` into the source file's EDITMODE JSON block. **This is a design-time file mutation performed by a tool outside this repo, not an app mutation.**
3. `window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*')` — on ✕.
4. `window.dispatchEvent(new CustomEvent('tweakchange', { detail: edits }))` — same-window fanout; zero listeners in this repo.

No task-file writes, no timeline events, no audit events, no SQLite, no SSE. Nothing here needs to become a React Router action.

---

## 6. CSS classes used

All defined **inside this file** in `__TWEAKS_STYLE` (injected `<style>`), namespaced `twk-`, hardcoded light-theme hex — **not part of `viberr.css` and not part of the ported design system contract.** Listed for completeness:

- Shell: `twk-panel` (fixed bottom-right, 280px, frosted glass, `transform: scale(var(--dc-inv-zoom, 1))`, `z-index: 2147483646`), `twk-hd`, `twk-x`, `twk-body`.
- Layout: `twk-row`, `twk-row-h` (horizontal modifier), `twk-lbl`, `twk-val`, `twk-sect`.
- Fields: `twk-field` (shared by select/text; select variant adds data-URI chevron), `twk-slider`, `twk-num`, `twk-num-lbl`, `twk-num-unit`.
- Segmented: `twk-seg`, `twk-seg.dragging`, `twk-seg-thumb`.
- Toggle: `twk-toggle` + `data-on="1|0"` attribute styling.
- Buttons: `twk-btn`, `twk-btn.secondary`.
- Color: `twk-swatch` (native input), `twk-chips`, `twk-chip` (+ `data-on`), with structural `>span>i` stacked-column selectors and an absolutely-positioned check SVG.
- Attributes/vars with host meaning: `data-omelette-chrome=""` (exclude from host captures), `--dc-inv-zoom` (host inverse zoom).

---

## 7. Porting notes

### Primary recommendation: exclude from the port

1. **It is dead code in the mock itself** — not `<script>`-included by any entry HTML, not referenced by any component. The only trace is the stale comment at `home.jsx:2`; when porting `home.jsx`, drop the "+ tweaks-panel.jsx" clause from any carried-over header comment.
2. It is design-time tooling for the omelette prototype harness (iframe + postMessage + source-file rewriting). The real app has no such host; `__edit_mode_set_keys` has no receiver and the EDITMODE block convention has no equivalent.
3. It is explicitly `@ds-adherence-ignore`: raw hex, raw px, its own class namespace, always-light styling that ignores the app's dark theme. Porting it verbatim would violate the app's own porting rules (no inline hex; tokens only), and "fixing" it would be effort spent on a tool nobody mounts.
4. Nothing in `docs/build` architecture (loaders/actions/SQLite/task store/SSE) has a slot for it.

**Concrete action for the porting engineer: create no file for this. Record the exclusion in the port's state/decision log so nobody "discovers" the missing file later.**

### If (and only if) a dev-time theme-tweaker is ever wanted in the real app

- Rebuild it as a `import.meta.env.DEV`-gated component (e.g. `app/features/dev-tweaks/`), never shipped in production bundles.
- Replace the host protocol: `__activate/__deactivate_edit_mode` → a local keyboard shortcut or dev menu; `__edit_mode_set_keys` → `localStorage` (or nothing — session-ephemeral is fine for a dev tool); keep the `tweakchange` CustomEvent pattern only if something subscribes.
- Replace `window.*` global exports with real ES module exports; replace the injected `<style>` string with a co-located stylesheet.
- Keep the genuinely good interaction details if rebuilding: the announce-after-listener ordering (race avoidance), value-in-ref during pointer drags (stale-closure avoidance), segmented→select fallback thresholds, type-preserving select resolver, right/bottom-offset drag with viewport clamping, scrub-to-adjust number label, and the JSON-key palette comparison.

### Edge cases worth knowing (for either path)

- **Empty/error states:** none rendered. Closed panel = `null`. `TweakRadio` with an option count other than 2–3 silently becomes a select. `TweakColor` with `options: []` or missing → native color input. `__twkIsLight` on non-hex input → treated as light (dark checkmark).
- `TweakSelect` emits strings; only the `TweakRadio` fallback path restores original types. Direct `TweakSelect` consumers storing numbers/booleans would get silent type drift into the persisted JSON.
- Panel drag uses mouse events (no touch); radio/number scrubbing uses pointer events (touch-capable). Inconsistent but irrelevant for a desktop dev tool.
- `TweakRadio` calls hooks (`useRef` ×2, `useState`) *before* the conditional `return <TweakSelect/>` — hook order is stable; safe as written. The fallback decision depends only on props, so it can't flip mid-lifecycle unless options/labels change.
- `useTweaks` never re-reads persisted values at runtime; the host's file rewrite only matters on next load (Babel re-parses the literal).
- The panel's `dismiss` optimistically closes locally *and* notifies the host; the host's `__deactivate_edit_mode` echo makes close idempotent and keeps the host toolbar in sync.
- `z-index: 2147483646` = max int32 − 1, deliberately one under the max so a host overlay can still sit above it.

---

## 8. Open questions

1. **Confirm exclusion with the design owner.** Is the omelette harness expected to run against the *ported* app during development (i.e., should any `__edit_mode_*` shim exist)? Current assumption: no.
2. `home.jsx:2` names this file in its load-order comment while no HTML loads it — was it removed from the entry files late, and are there other stale references in design docs (`design/` beyond `html-app/`) worth sweeping?
3. If a dev theme-tweaker is wanted post-port, which tokens would it drive (`--viberr-*` custom properties? theme cookie?) — that determines whether any of §4's control behaviors are worth rebuilding vs. just using browser devtools.
4. Should the port's tooling docs mention `data-omelette-chrome` / `--dc-inv-zoom` anywhere, or do those conventions die with the prototype? Current assumption: they die with the prototype.
