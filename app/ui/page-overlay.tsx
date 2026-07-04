import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icon";

/**
 * Full-page-as-popup modal, ported from design/html-app/app/ui.jsx with the
 * ruling-mandated dialog behaviors added (markup unchanged): Escape close,
 * scrim-click close, focus trap, initial focus, focus restore, body scroll
 * lock. Fixes the mock's stale-onClose effect via a ref.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PageOverlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(".overlay-x")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab" && panel) {
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(FOCUSABLE),
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !panel.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <>
      <div className="confirm-scrim" onClick={() => onCloseRef.current()} />
      <div
        className="page-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-screen-label={label + " — overlay"}
        ref={panelRef}
      >
        <button
          className="icon-btn overlay-x"
          onClick={() => onCloseRef.current()}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
        <div className="page-overlay-body">{children}</div>
      </div>
    </>
  );
}
