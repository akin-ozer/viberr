import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

/**
 * Toast stack, ported from design/html-app/app/ui.jsx: bottom-center,
 * auto-dismiss after 2600 ms, check icon (mock toasts are success-only —
 * errors render inline/route-level per CONVENTIONS). Phase 4 mounts
 * ToastHost in the shell; a context provider can wrap this hook there if
 * prop-drilling `push` gets unwieldy.
 */

export interface Toast {
  id: string;
  text: string;
}

const TOAST_DISMISS_MS = 2600;

export function useToasts(): { toasts: Toast[]; push: (text: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const push = useCallback((text: string) => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, text }]);
    timers.current.push(
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_DISMISS_MS),
    );
  }, []);

  return { toasts, push };
}

export function ToastHost({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <Icon name="check" />
          {t.text}
        </div>
      ))}
    </div>
  );
}
