import { redirect } from "react-router";
import type { Route } from "./+types/project._index";

/** /projects/:slug → the board (docs/ui/surfaces.md route table). */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/projects/${params.slug}/board`);
}
