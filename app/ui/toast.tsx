import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icon";

/**
 * Toast stack, ported from design/html-app/app/ui.jsx: bottom-center,
 * auto-dismiss after 2600 ms, check icon (mock toasts are success-only —
 * errors render inline/route-level per CONVENTIONS). Phase 4 mounts ONE
 * ToastProvider in root.tsx; features call useToast() instead of the
 * mock's prop-drilled `push`.
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

const ToastContext = createContext<(text: string) => void>(() => {});

/** App-wide toast context: mounts the single ToastHost (root layout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, push } = useToasts();
  return (
    <ToastContext.Provider value={push}>
      {children}
      <ToastHost toasts={toasts} />
    </ToastContext.Provider>
  );
}

/** `push(text)` — 2600 ms auto-dismissing confirmation toast. */
export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}
