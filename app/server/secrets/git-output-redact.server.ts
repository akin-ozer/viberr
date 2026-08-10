/**
 * Scrub git's OWN output so it can be shown to a human (F19-6 / F19-18).
 *
 * The clone and the delivery push both used to drop git's `stderr` wholesale,
 * "because child process errors may echo command arguments or authentication
 * diagnostics". The premise does not hold for how Viberr invokes git: the PAT
 * travels only through the `GIT_ASKPASS` helper's environment
 * (`git-clone-auth.server`), argv carries the credential-free
 * `https://github.com/<owner>/<repo>.git`, and that is also what git persists as
 * `remote.origin.url`. The suppression's cost was real and was paid live: a
 * transient `git exit 128` clone failure left the agent blocked, the operator
 * opening an honest blocked packet whose recommended option was "hold for infra
 * to investigate" — and nothing anywhere for infra to investigate.
 *
 * So the channel is opened, scrubbed. Three layers, strongest first:
 *   1. the EXACT project credential, by value — both call sites hold the token
 *      at the failure site, so this layer needs no guessing and no shape;
 *   2. URL userinfo (`https://user:secret@host`), the one shape a legacy
 *      token-bearing origin written by an older Viberr could reach stderr in;
 *   3. known token SHAPES, for a credential nobody here supplied.
 *
 * Then ANSI/control-character stripping (a timeline note and an agent prompt are
 * plain text, never a coloured TTY stream), and a hard clamp, because the text
 * lands on a task-timeline note that the operator reads through
 * `operatorSnapshot`, which caps one event at 1500 chars.
 */

export const REDACTED = "[redacted]";

/**
 * Token shapes worth redacting on sight — anchored prefixes plus a length
 * floor, so ordinary prose ("sk-1", "gh_") is never touched. Deliberately NOT
 * an entropy heuristic: mangling git's diagnosis is a worse failure than the
 * leak this backstops, and layers 1-2 above are the ones that actually carry
 * the guarantee.
 *
 * `createLineRedactor` (run-sink.server) keeps an identical list for run-log
 * lines; the two must stay in step, and the run-log copy should import this one
 * so there is a single list.
 */
export const TOKEN_SHAPE_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}", // ghp_/gho_/ghu_/ghs_/ghr_ GitHub tokens
  "github_pat_[A-Za-z0-9_]{20,}", // fine-grained PAT
  "sk-[A-Za-z0-9_-]{16,}", // sk-ant-…, sk-proj-…, OpenAI/Anthropic keys
].join("|");

/** `scheme://user:secret@host` — git echoes remote URLs verbatim. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi;

/** ANSI CSI escape sequences (`ESC [ … m` and friends): git colourises
 *  `error:`/`hint:` when it thinks it has a TTY. */
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** C0 control characters that survive the line split (NUL, BEL, …). `\t` (	)
 *  is spared; `\r`/`\n` are consumed by the split, so they never reach here. */
// eslint-disable-next-line no-control-regex
const C0_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Below this length a "token" the caller handed us is a flag or a placeholder,
 * not a secret, and scrubbing it by value would mangle unrelated output.
 */
const MIN_TOKEN_LEN = 8;

/** The tail is where git states its verdict; the head is the command echo and,
 *  for a clone, the transfer progress. */
const MAX_DETAIL_LINES = 8;
/** Keeps the rendered note well inside operatorSnapshot's 1500-char per-event
 *  cap, even once the surrounding prose is added. */
const MAX_DETAIL_CHARS = 600;

/**
 * Turn raw git output into a short, secret-free block safe for a log field, a
 * task-timeline note and an agent prompt. Returns `""` when git said nothing —
 * every caller renders the detail conditionally, so empty means "no block".
 */
export function redactGitOutput(
  text: string | null | undefined,
  opts: { token?: string | null } = {},
): string {
  if (!text) return "";
  let out = text;
  // Layer 1 — by value. `split`/`join` needs no regex escaping, which matters:
  // a PAT is not guaranteed to be regex-inert.
  if (opts.token && opts.token.length >= MIN_TOKEN_LEN) {
    out = out.split(opts.token).join(REDACTED);
  }
  // Layer 2 — userinfo. Runs AFTER layer 1 so `x-access-token:<pat>@host`,
  // already reduced to `x-access-token:[redacted]@host`, still loses the
  // username half (it names the credential mechanism, not just the value).
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  // Layer 3 — shapes.
  out = out.replace(new RegExp(TOKEN_SHAPE_SOURCE, "g"), REDACTED);

  // Strip ANSI colour sequences before the split so a colourised `error:` line
  // is not spent on escape bytes.
  out = out.replace(ANSI_CSI_RE, "");

  // A bare CR is a line here too: git writes transfer progress as one physical
  // line rewritten with `\r`, and keeping it whole would spend the entire clamp
  // on "Receiving objects: 41%".
  const lines = out
    .split(/\r\n|\r|\n/)
    // Strip any stray C0 control character left inside a line; `\t` is kept.
    .map((l) => l.replace(C0_CONTROL_RE, "").trimEnd())
    .filter((l) => l.trim() !== "");
  const kept = lines.slice(-MAX_DETAIL_LINES).join("\n").trim();
  // Clamp from the END, not the start: a clamp that drops git's verdict to keep
  // its command echo defeats the entire point of surfacing this.
  return kept.length > MAX_DETAIL_CHARS
    ? `…${kept.slice(-MAX_DETAIL_CHARS)}`
    : kept;
}

/**
 * The best text a rejected `execFile` promise can offer: git's stderr when it
 * said anything, else the wrapper's own message (which quotes argv — already
 * credential-free by construction, and scrubbed anyway).
 */
export function gitErrorText(error: unknown): string {
  const value =
    typeof error === "object" && error !== null
      ? (error as { stderr?: unknown; message?: unknown })
      : {};
  const stderr = typeof value.stderr === "string" ? value.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof value.message === "string" ? value.message : "";
}
