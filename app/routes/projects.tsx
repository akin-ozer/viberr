import { redirect } from "react-router";

/**
 * Bare `/projects` has no listing of its own — the home page (`/`) is the
 * project list. Redirect there instead of 404ing a reasonable-looking URL (N5).
 */
export function loader() {
  return redirect("/");
}
