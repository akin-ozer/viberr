import { type ReactNode } from "react";
import { Icon } from "./icon";
import { useDialog } from "./use-dialog";

/**
 * Full-page modal built on native <dialog> via useDialog (focus trap, initial
 * focus, Escape, backdrop-click close, scroll lock, focus restore — come from
 * showModal() + the hook; the old hand-rolled trap and scrim div are gone).
 */
export function PageOverlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { ref: panelRef, close } = useDialog(onClose);

  return (
    <dialog
      className="page-overlay"
      aria-label={label}
      data-screen-label={label + " — overlay"}
      ref={panelRef}
    >
      <button
        type="button"
        className="icon-btn overlay-x"
        onClick={close}
        aria-label="Close"
      >
        <Icon name="x" />
      </button>
      <div className="page-overlay-body">{children}</div>
    </dialog>
  );
}
