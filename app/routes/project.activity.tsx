import type { Route } from "./+types/project.activity";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full Activity view is Phase 9. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function ActivityView() {
  return (
    <PlaceholderView title="Activity" phase={9} screenLabel="Activity — placeholder" />
  );
}
