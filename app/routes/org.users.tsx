import { redirect } from "react-router";

/**
 * /org/users — the phase-2 TEMPORARY admin page is retired: the real
 * org-user surface is the Users & access tab of /org/settings (Phase 9B).
 * Old links/bookmarks land there.
 */
export function loader() {
  return redirect("/org/settings?tab=users");
}
