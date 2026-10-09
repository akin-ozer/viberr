import { z } from "zod";

/**
 * Ruling 74 (F40-51): notifications that reach a tab nobody is looking at.
 *
 * Notifications stay in-app (docs/product/overview.md: no mailer, no push
 * service). What changed is that an open Viberr tab now says so when it is not
 * in front of the person: its title carries the count of unread decisions
 * ("(1) WEB-3 · … · Viberr"), and, when the person opted in on Profile, the
 * browser shows a system notification for each new one. Both are fed by
 * `/resources/attention` (`attentionSnapshot`), read by the root-mounted
 * `AttentionWatcher`.
 *
 * The opt-in is per BROWSER, not per account: the permission it rests on is
 * the browser's, granted to this origin on this device, so a stored account
 * preference would claim notifications on a laptop that never allowed them.
 * The permission is asked for only when the person switches the toggle on.
 */

/** Where the watcher reads the count and the newest unread decisions. */
export const ATTENTION_URL = "/resources/attention";

/** One unread decision, worded for a desktop notification. */
const attentionItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  /** Where the bell would open it; null for a row that concerns no page. */
  href: z.string().nullable(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const attentionSchema = z.object({
  /** Unread decisions (packet, agent question, approval) that lead somewhere. */
  waiting: z.number().int().nonnegative(),
  /** The newest of them, newest first (`ATTENTION_ITEM_CAP`). */
  items: z.array(attentionItemSchema),
});
export type AttentionSnapshot = z.infer<typeof attentionSchema>;

/** `(3) Board · akinozer.com · Viberr`: the count first, where a tab strip
 *  that truncates the title still shows it. */
export function titleWithCount(base: string, count: number): string {
  if (count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}

// ------------------------------------------------------------ storage

/** This browser's opt-in (Profile → Notification routing → Desktop). */
const DESKTOP_KEY = "viberr.desktop-notifications";
/** Decision ids this browser already announced or showed to an attentive
 *  tab, shared by its tabs so two open tabs do not both announce one row. */
const HANDLED_KEY = "viberr.attention.handled";
const HANDLED_CAP = 200;

/** The page's own storage. `window`'s, not a bare `localStorage`: Node 26
 *  defines a global of that name too, and it is not the browser's. */
function browserStorage(): Storage | undefined {
  return "window" in globalThis ? window.localStorage : undefined;
}

/** Storage can be missing or throw (a private window, blocked site data), and
 *  the watcher then keeps its own tab's memory instead. */
let handledInMemory: string[] = [];

const handledSchema = z.array(z.string());

function readHandled(): string[] {
  try {
    const storage = browserStorage();
    if (!storage) return handledInMemory;
    const raw = storage.getItem(HANDLED_KEY);
    const parsed = handledSchema.safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : handledInMemory;
  } catch {
    return handledInMemory;
  }
}

function writeHandled(ids: string[]): void {
  handledInMemory = ids;
  try {
    browserStorage()?.setItem(HANDLED_KEY, JSON.stringify(ids));
  } catch {
    // Kept in memory above.
  }
}

/**
 * The items no tab of this browser has handled yet, which are now handled.
 * `prime` is a tab's first reading: it cannot tell a new row from one that
 * was already waiting when the tab opened, so it records them and announces
 * nothing.
 */
export function takeUnhandled<T extends { id: string }>(items: readonly T[], prime: boolean): T[] {
  const handled = readHandled();
  const known = new Set(handled);
  const fresh = items.filter((item) => !known.has(item.id));
  if (fresh.length === 0) return [];
  writeHandled([...handled, ...fresh.map((item) => item.id)].slice(-HANDLED_CAP));
  return prime ? [] : fresh;
}

function readOptIn(): boolean {
  try {
    return browserStorage()?.getItem(DESKTOP_KEY) === "on";
  } catch {
    return false;
  }
}

function writeOptIn(on: boolean): void {
  try {
    if (on) browserStorage()?.setItem(DESKTOP_KEY, "on");
    else browserStorage()?.removeItem(DESKTOP_KEY);
  } catch {
    // Nothing to keep: without storage the opt-in cannot outlive the page.
  }
}

// ------------------------------------------------------------ permission

/**
 * Where desktop notifications stand in THIS browser:
 * - `unsupported`: no Notification API, or an address it refuses (it needs
 *   HTTPS or localhost), or a platform that shows them only from an
 *   installed app;
 * - `blocked`: the person (or a policy) denied Viberr in site settings;
 * - `off` / `on`: allowed or not yet asked, and the person's own switch.
 */
export type DesktopAlertState = "unsupported" | "blocked" | "off" | "on";

export function desktopAlertState(): DesktopAlertState {
  if (!("Notification" in globalThis) || globalThis.isSecureContext === false) {
    return "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  return readOptIn() ? "on" : "off";
}

/** Shows one notification; false when the platform refused to construct it
 *  (Android Chrome shows them only from a service worker). A click focuses
 *  the tab that showed it and hands over to `onOpen`. */
export function showDesktopAlert(
  item: Pick<AttentionItem, "id" | "title" | "body">,
  onOpen?: () => void,
): boolean {
  try {
    const shown = new Notification(item.title, {
      body: item.body,
      // One per row across every tab of this browser: the platform replaces a
      // notification that carries the same tag.
      tag: item.id,
      icon: "/favicon.svg",
    });
    shown.onclick = () => {
      window.focus();
      shown.close();
      onOpen?.();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * The toggle's switch-on: asks for the permission (the only place Viberr ever
 * does), shows one notification to prove the platform can, and records the
 * opt-in only then.
 */
export async function enableDesktopAlerts(): Promise<DesktopAlertState> {
  const before = desktopAlertState();
  if (before === "unsupported" || before === "on") return before;
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  const shown = showDesktopAlert({
    id: "viberr-desktop-notifications-on",
    title: "Desktop notifications are on",
    body: "Viberr will tell you here when a decision waits on you and no Viberr tab is in front of you.",
  });
  if (!shown) return "unsupported";
  writeOptIn(true);
  return "on";
}

export function disableDesktopAlerts(): void {
  writeOptIn(false);
}
