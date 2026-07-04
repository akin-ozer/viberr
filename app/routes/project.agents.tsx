import type { Route } from "./+types/project.agents";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full Agents view is Phase 9. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function AgentsView() {
  return (
    <PlaceholderView title="Agents" phase={9} screenLabel="Agents — placeholder" />
  );
}
