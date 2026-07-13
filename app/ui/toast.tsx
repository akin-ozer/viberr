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
 * auto-dismiss after 2600 ms. Feedback is typed so a failed mutation can
 * never be rendered with the success checkmark. Phase 4 mounts ONE
 * ToastProvider in root.tsx; features call useToast() instead of the mock's
 * prop-drilled `push`.
 */

export type ToastKind = "success" | "error" | "info";

export type ToastInput =
  | string
  | {
      text: string;
      kind: ToastKind;
    };

export interface Toast {
  id: string;
  text: string;
  kind: ToastKind;
}

export type PushToast = (input: ToastInput) => void;

const TOAST_DISMISS_MS = 2600;

export function useToasts(): { toasts: Toast[]; push: PushToast } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const push = useCallback((input: ToastInput) => {
    const { text, kind } =
      typeof input === "string"
        ? { text: input, kind: "success" as const }
        : input;
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, text, kind }]);
    timers.current.push(
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_DISMISS_MS),
    );
  }, []);

  return { toasts, push };
}

function ToastHost({ toasts }: { toasts: Toast[] }) {
  return (
    // The live-region attributes live on the always-mounted wrapper so screen
    // readers register the region before content arrives; a region created at
    // the same time as its text is not reliably announced. Error toasts escalate
    // to assertive via role="alert" on the individual node.
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          className={`toast ${t.kind}`}
          key={t.id}
          {...(t.kind === "error"
            ? { role: "alert" as const, "aria-live": "assertive" as const }
            : {})}
        >
          <Icon
            name={
              t.kind === "success"
                ? "check"
                : t.kind === "error"
                  ? "alert"
                  : "bell"
            }
          />
          {t.text}
        </div>
      ))}
    </div>
  );
}

const ToastContext = createContext<PushToast>(() => {});

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

/** Strings are success feedback; pass `{ kind, text }` for errors/info. */
export function useToast(): PushToast {
  return useContext(ToastContext);
}
