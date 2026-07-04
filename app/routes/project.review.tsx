import type { Route } from "./+types/project.review";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full Review queue view is Phase 9. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function ReviewView() {
  return (
    <PlaceholderView title="Review queue" phase={9} screenLabel="Review queue — placeholder" />
  );
}
