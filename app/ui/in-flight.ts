/**
 * Ruling 368: the intent a fetcher is carrying, or null while it is idle.
 *
 * A fetcher keeps its form data through `submitting` and the revalidating
 * `loading` that follows, which is exactly the stretch a person waits through,
 * so a surface whose one fetcher serves several buttons can tell which button
 * started the request: that one shows it in flight (`aria-busy`, the loader
 * spinning where its glyph was, a label naming the work) and its siblings only
 * wait at the disabled step.
 */
export function inFlightIntent(fetcher: {
  state: "idle" | "loading" | "submitting";
  formData?: FormData | undefined;
}): string | null {
  if (fetcher.state === "idle" || !fetcher.formData) return null;
  return String(fetcher.formData.get("intent") ?? "");
}
