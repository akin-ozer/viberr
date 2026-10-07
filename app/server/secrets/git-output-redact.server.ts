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
 *      at the failure site, so this layer needs no guessing and no pattern;
 *   2. URL userinfo (`https://user:secret@host`), the one shape a legacy
 *      token-bearing origin written by an older Viberr could reach stderr in;
 *   3. known token PATTERNS, for a credential nobody here supplied.
 *
 * Then ANSI/control-character stripping (a timeline note and an agent prompt are
 * plain text, never a coloured TTY stream), and a hard clamp, because the text
 * lands on a task-timeline note that the operator reads through
 * `operatorSnapshot`, which caps one event at 1500 chars.
 */

import { z } from "zod";

export const REDACTED = "[redacted]";

/**
 * Token patterns worth redacting on sight — anchored prefixes plus a length
 * floor, so ordinary prose ("sk-1", "gh_") is never touched. Deliberately NOT
 * an entropy heuristic: mangling git's diagnosis is a worse failure than the
 * leak this backstops, and layers 1-2 above are the ones that actually carry
 * the guarantee.
 *
 * `createLineRedactor` (run-sink.server) keeps an identical list for run-log
 * lines; the two must stay in step, and the run-log copy should import this one
 * so there is a single list.
 */
export const TOKEN_PATTERN_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}", // ghp_/gho_/ghu_/ghs_/ghr_ GitHub tokens
  "github_pat_[A-Za-z0-9_]{20,}", // fine-grained PAT
  "sk-[A-Za-z0-9_-]{16,}", // sk-ant-…, sk-proj-…, OpenAI/Anthropic keys
].join("|");

/** `scheme://user:secret@host` — git echoes remote URLs verbatim. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi;

/**
 * Ruling 690: whether a text holds what reads as a credential, by the two
 * shapes the scrub below removes on sight: a token by its prefix, and a
 * password in a URL's userinfo. A kept source is stored as it is and every
 * project member can open it, so the keep refuses on these rather than
 * rewriting what it was handed.
 *
 * A token is taken only where it starts a word. The scrub can afford to
 * redact the tail of `task-management-best-practices` in a line of git
 * output; a refusal cannot, because that is an ordinary page address and the
 * agent has no other one to give.
 */
export function readsAsCredential(text: string): boolean {
  return (
    new RegExp(`(?<![A-Za-z0-9_-])(?:${TOKEN_PATTERN_SOURCE})`).test(text) ||
    // A copy without the global flag: `.test` on the shared one keeps state.
    new RegExp(URL_USERINFO_RE.source, "i").test(text)
  );
}

/** ANSI CSI escape sequences (`ESC [ … m` and friends): git colourises
 *  `error:`/`hint:` when it thinks it has a TTY, and so do the vendor CLIs'
 *  sign-in prompts (`backend-login.server.ts` strips them with this too).
 *
 *  Global, so use it ONLY with `.replace`, which resets `lastIndex` itself;
 *  a `.test`/`.exec` on this shared instance would carry state between calls.
 *
 *  The leading ESC IS a control character, and matching it is the entire point
 *  of the pattern — the same waiver `C0_CONTROL_RE` below already carries.
 *  Stated rather than dodged: assembling ESC at runtime to hide it from the
 *  linter would buy nothing and cost the reader the pattern. */
// eslint-disable-next-line no-control-regex
export const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** C0 control characters that survive the line split (NUL, BEL, …). `\t` (	)
 *  is spared; `\r`/`\n` are consumed by the split, so they never reach here. */
// eslint-disable-next-line no-control-regex
const C0_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

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
  //
  // F20-7: scrub the caller's credential at ANY length — the old
  // `>= MIN_TOKEN_LEN` (8) floor let a short secret ride straight through into
  // the MCP row error, the toast, and the persisted `last_error` (live: a
  // 5-char `MCP_CREDENTIAL` printed as `CRED=xy7Qk`). The by-value pass is
  // exact — it only ever removes the string the caller HANDED us, so a shorter
  // value has nothing extra to mangle; the floor only ever protected a leak.
  // The empty-string case is still guarded (falsy `opts.token`), because a
  // split on "" would insert `[redacted]` between every character.
  if (opts.token) {
    out = out.split(opts.token).join(REDACTED);
  }
  // Layer 2 — userinfo. Runs AFTER layer 1 so `x-access-token:<pat>@host`,
  // already reduced to `x-access-token:[redacted]@host`, still loses the
  // username half (it names the credential mechanism, not just the value).
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  // Layer 3 — patterns.
  out = out.replace(new RegExp(TOKEN_PATTERN_SOURCE, "g"), REDACTED);

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
 * R20-3 (F20-4): one redacted SENTENCE from a Claude/Codex provider failure,
 * for a packet observation line, a fenced timeline block and a log field.
 *
 * Ruling 69's argument transfers verbatim from git to the model runtimes: the
 * credential never lives in argv (both adapters get it on the run's spawn env,
 * assembled per run from its credential principal), so the same value+pattern scrub plus
 * control-character stripping makes a provider's own complaint safe to surface.
 * `redactGitOutput` already IS that shared child-process scrubber, so this
 * layers on top of it: coerce the (possibly nested) error to text, scrub, keep
 * the LAST non-empty line (the provider states its verdict at the tail, same as
 * git — see MAX_DETAIL_CHARS's reasoning), and clamp shorter still, because the
 * consumers (a packet observation, the 240-char delivery-reason convention from
 * ruling 69) want one sentence, not eight lines.
 */
export const PROVIDER_TEXT_CHARS = 240;

/** A provider failure's messages, outermost first, down three levels of
 *  `cause`: the SDKs wrap the real message a couple of layers down. Shared by
 *  this scrub and `classifyCodexFailure`, which must read the same text. */
export function causeMessages(cause: unknown): string[] {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 3 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts;
}

export function redactProviderText(
  cause: unknown,
  token?: string | null,
): string {
  const scrubbed = redactGitOutput(causeMessages(cause).join("\n"), { token });
  if (!scrubbed) return "";
  const lines = scrubbed.split("\n").filter((l) => l.trim() !== "");
  const last = (lines.length ? lines[lines.length - 1]! : "").trim();
  return last.length > PROVIDER_TEXT_CHARS
    ? `…${last.slice(-PROVIDER_TEXT_CHARS)}`
    : last;
}

/**
 * The best text a rejected `execFile` promise can offer: git's stderr when it
 * said anything, else the wrapper's own message (which quotes argv — already
 * credential-free by construction, and scrubbed anyway).
 */
/** The two fields are decoded SEPARATELY, not as one object: a rejection that
 *  carries a non-string `stderr` (a Buffer, when a caller drops the string
 *  encoding) must still fall through to the message rather than lose both. */
const gitStderrSchema = z.object({ stderr: z.string() });
const gitMessageSchema = z.object({ message: z.string() });

export function gitErrorText(cause: unknown): string {
  const withStderr = gitStderrSchema.safeParse(cause);
  if (withStderr.success) {
    const stderr = withStderr.data.stderr.trim();
    if (stderr) return stderr;
  }
  const withMessage = gitMessageSchema.safeParse(cause);
  return withMessage.success ? withMessage.data.message : "";
}
