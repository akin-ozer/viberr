import type { Route } from "./+types/project.github";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full GitHub view is Phase 7. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function GithubView() {
  return (
    <PlaceholderView title="GitHub" phase={7} screenLabel="GitHub — placeholder" />
  );
}
