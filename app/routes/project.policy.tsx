import type { Route } from "./+types/project.policy";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full Policy view is Phase 9. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function PolicyView() {
  return (
    <PlaceholderView title="Policy" phase={9} screenLabel="Policy — placeholder" />
  );
}
