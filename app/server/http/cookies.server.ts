/**
 * The values a request's `Cookie` header carries under `name`, in the order it
 * sends them: two cookies can share a name when their paths differ, so a
 * reader takes the first one it accepts. Each value is percent-decoded when it
 * decodes and kept raw when it does not; it is untrusted text either way, and
 * the caller validates it before it means anything.
 */
export function cookieValues(request: Request, name: string): string[] {
  const header = request.headers.get("Cookie");
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }
  return values;
}
