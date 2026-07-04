import type { Route } from "./+types/project.settings";
import { requireUser } from "~/server/auth/require-user.server";
import { PlaceholderView } from "~/features/shell/placeholder-view";

/** Real route, placeholder surface — the full Settings view is Phase 9. */
export function loader({ request }: Route.LoaderArgs) {
  requireUser(request);
  return null;
}

export default function SettingsView() {
  return (
    <PlaceholderView title="Settings" phase={9} screenLabel="Settings — placeholder" />
  );
}
