import { useState, type CSSProperties } from "react";

/**
 * WCAG 2.4.1 bypass block (UI-12). The workspace shell puts a 7-item nav rail
 * and a topbar (brand, crumbs, search, bell, avatar menu) ahead of the content
 * on EVERY navigation, and the app had no skip mechanism anywhere.
 *
 * Styles are inline on purpose: `app/app.css` carries no visually-hidden
 * utility, and this component has to work on any surface that mounts it without
 * a stylesheet change. Visibility is driven by focus state rather than `:focus`
 * so the link stays out of the visual layout until a keyboard user reaches it.
 */
const HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

const VISIBLE: CSSProperties = {
  position: "fixed",
  top: ".6rem",
  left: ".6rem",
  zIndex: 300,
  padding: ".5rem .8rem",
  borderRadius: ".5rem",
  background: "var(--surface)",
  color: "var(--fg)",
  border: "2px solid var(--blue)",
  font: "inherit",
  fontWeight: 700,
  textDecoration: "none",
  // The element is itself a focus indicator (border, surface, position); the
  // app-wide :focus-visible ring would stack a second concentric blue ring.
  outline: "none",
};

export function SkipLink({
  targetId = "main-content",
  label = "Skip to main content",
}: {
  targetId?: string;
  label?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <a
      href={`#${targetId}`}
      style={focused ? VISIBLE : HIDDEN}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {label}
    </a>
  );
}
