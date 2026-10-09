// Lives apart from controller-page.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * Ruling 249: the surface a message was sent from, as a short word — the
 * workspace view's name, a task key, or "Home". The full path stays in the
 * title attribute.
 */
export function surfaceLabel(surface: string): string {
  const path = surface.split("?")[0] ?? surface;
  const task = path.match(/^\/projects\/[^/]+\/tasks\/([^/]+)/);
  if (task?.[1]) return task[1];
  const view = path.match(/^\/projects\/[^/]+(?:\/([^/]+))?/);
  if (view) {
    const segment = view[1] ?? "board";
    return segment.charAt(0).toUpperCase() + segment.slice(1);
  }
  if (path === "/") return "Home";
  const top = path.split("/").filter(Boolean)[0] ?? "";
  return top ? top.charAt(0).toUpperCase() + top.slice(1) : "Home";
}
