import { useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "../root";

/**
 * Hidden CSRF token field for every mutating <Form>. The token comes from
 * the root loader (derived from the current session), so any form anywhere
 * in the tree can simply include <CsrfInput />.
 * Server side: actions call assertCsrf(request, sessionId, formData).
 */
export function CsrfInput() {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  return <input type="hidden" name="_csrf" value={data?.csrf ?? ""} />;
}
