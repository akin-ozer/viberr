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
 * Bottom-center toast stack with 2600 ms auto-dismiss. Errors render
 * inline or at route level; the root mounts one
 * ToastProvider in root.tsx; features call useToast() instead of the
 * mock's prop-drilled `push`.
 */

export interface Toast {
  id: string;
  text: string;
  /** Exit phase: `.leaving` plays the 200 ms fade-down before unmount. */
  leaving?: boolean;
}

const TOAST_DISMISS_MS = 2600;
const TOAST_EXIT_MS = 200;

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
    // Two-phase dismissal: mark `leaving` (CSS plays the exit transition,
    // mirroring the `rise` entrance path), then unmount after it settles.
    timers.current.push(
      setTimeout(() => {
        setToasts((t) =>
          t.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
        );
      }, TOAST_DISMISS_MS),
    );
    timers.current.push(
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_DISMISS_MS + TOAST_EXIT_MS),
    );
  }, []);

  return { toasts, push };
}

function ToastHost({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={"toast" + (t.leaving ? " leaving" : "")} key={t.id}>
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
