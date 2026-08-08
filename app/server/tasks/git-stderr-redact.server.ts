/**
 * Credential-safe git diagnostics (F19-6 / F19-18).
 *
 * Viberr ran every git child process with its stderr thrown away. The rule it
 * was implementing is real (NFR7 / FR34: no secret in a log, a timeline, a
 * comment or an error message) — but it was implemented as "drop ALL
 * diagnostics" rather than "redact the one secret that can appear", and the
 * cost was paid by humans:
 *
 *  · a failed workspace clone said only "git exit 128" — which covers auth
 *    rejection, a missing remote, DNS, a proxy, an LFS hook — on every surface
 *    a person can read (`cloneFailureSentence`, the timeline note, the agent
 *    prompt, and therefore the operator's blocked packet). Live: the same repo
 *    cloned fine from a shell and nobody could act (F19-6/VC-3);
 *  · a failed delivery push said only "git push returned non-zero", so a
 *    protected-branch / push-ruleset / pre-receive rejection reached the
 *    timeline with no cause at all and the maintainer had to reproduce the
 *    push outside Viberr — the make-or-break failure the UX spec names
 *    (F19-18).
 *
 * The redaction premise is verifiable rather than assumed: the PAT reaches git
 * ONLY through the `GIT_ASKPASS` environment (`createGitHubAskpassEnv` /
 * `createGitHubClonePlan`) — never argv, never the remote URL, never a
 * persisted config entry — and the caller holds the exact secret string at the
 * catch site. So a literal scrub of the known token plus a URL-userinfo pattern
 * scrub (belt, for a legacy `x-access-token:<PAT>@github.com` origin an older
 * Viberr wrote) is sufficient. Both callers pass their token.
 *
 * FAIL-CLOSED SHAPE: everything here narrows. Nothing is returned when there is
 * no usable text, control characters are stripped (a timeline note must not
 * carry ANSI or a NUL), and only the TAIL survives the length cap — git prints
 * the `fatal:`/`remote:` line that names the cause last.
 */

/** Keep the last N characters — git's decisive line is at the end. */
const MAX_EXCERPT_CHARS = 500;

/** Replacement for anything scrubbed, so the reader sees that text was removed
 *  rather than reading a mangled sentence. */
const REDACTED = "[redacted]";

function rawStderrOf(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (typeof source === "object" && source !== null) {
    const value = source as { stderr?: unknown; message?: unknown };
    if (typeof value.stderr === "string" && value.stderr.trim()) {
      return value.stderr;
    }
    if (typeof value.message === "string") return value.message;
  }
  return undefined;
}

/**
 * A redacted, truncated excerpt of git's own error output — safe for the run
 * log, the task timeline, an agent prompt and a decision packet.
 *
 * `source` may be the caught error (its `stderr`, else its `message`) or a
 * stderr string. `secrets` are scrubbed literally; pass the token that
 * authenticated the invocation. Returns undefined when nothing usable is left,
 * which every caller treats as "same behaviour as before" — the excerpt is an
 * ADDITION to the existing classified reason, never a replacement for it.
 */
export function redactGitStderr(
  source: unknown,
  secrets: readonly string[] = [],
): string | undefined {
  const raw = rawStderrOf(source);
  if (!raw?.trim()) return undefined;
  let out = raw;
  for (const secret of secrets) {
    // Guard against a short/empty "secret" turning the whole excerpt into
    // redaction markers (an empty split() would explode character-wise).
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  out = out
    // `https://x-access-token:<pat>@github.com/...` and any other userinfo an
    // older clone's origin URL may still carry.
    .replace(/\/\/[^/\s@]+:[^/\s@]*@/g, `//${REDACTED}@`)
    .replace(/x-access-token:[^@\s]+/g, `x-access-token:${REDACTED}`)
    // ANSI colour/control sequences and stray control characters: a timeline
    // note and a prompt are plain text.
    // Newlines and tabs survive; everything else in the C0 range (\r included)
    // does not.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!out) return undefined;
  return out.length > MAX_EXCERPT_CHARS
    ? `…${out.slice(-MAX_EXCERPT_CHARS)}`
    : out;
}
