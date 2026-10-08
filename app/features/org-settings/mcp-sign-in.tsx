import { useState } from "react";
import type { McpView } from "~/server/org/resources.server";
import { isWriteScope, mcpGrantPhrase, summarizeMcpGrant, type McpOAuthView } from "~/shared/mcp-oauth";
import { countLabel } from "~/shared/text/plural";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { signInStateKey, signInStatus } from "./resource-modals-derive";
import { useOrgAction, type OrgAction } from "./use-org-action";

/**
 * The MCP-server editor's OAuth sign-in (ruling 469) and what it was granted
 * (ruling 486). Split out of `resource-modals.tsx` by ruling 696(e), along
 * the task-page recipe: McpSignIn keeps the two posts it always owned, and
 * its controls take their slot of its markup without a hook of their own.
 */

/**
 * Ruling 486: what a sign-in was granted, under its status line. The summary
 * ("read-only · 194 scopes") says whether a run may write through the
 * connection; the full list sits in a disclosure, each write marked. It looks
 * like a GitHub connection's reach list (`.conn-reach`), so the stylesheet
 * every page loads does not grow for it.
 */
function McpGrant({ scope }: { scope: string | null }) {
  const grant = summarizeMcpGrant(scope);
  if (!grant) return <span className="fhint">The server did not say which scopes it granted.</span>;
  return (
    <>
      <span className="fhint">
        Granted {mcpGrantPhrase(scope)}
        {grant.writes.length === 0
          ? ". Runs can read through it, and the server refuses any call that writes. To allow writes, add write scopes to Requested scopes above, save, and sign in again."
          : "."}
      </span>
      <details className="conn-reach">
        <summary>
          <span>The {countLabel(grant.scopes.length, "scope")} it granted</span>
          <Icon name="chevron" className="disc-chev" />
        </summary>
        <ul className="conn-reach-list" aria-label="Granted scopes">
          {grant.scopes.map((granted) => (
            <li key={granted}>
              <span className="mono">{granted}</span>
              {isWriteScope(granted) && <span className="conn-reach-ro">write</span>}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** The sign-in's controls: Sign in (again), Sign out, and the link to the
 *  server's own sign-in page once the server handed one back. */
function McpSignInActions({
  mcp,
  oauth,
  signedIn,
  busy,
  start,
  signOut,
  link,
  setErr,
}: {
  mcp: McpView;
  oauth: McpOAuthView | null;
  signedIn: boolean;
  busy: boolean;
  start: OrgAction;
  signOut: OrgAction;
  link: { url: string; issuer: string | null } | null;
  setErr: (err: string | null) => void;
}) {
  return (
    <span className="cred-manage" role="group" aria-labelledby="mcp-oauth-label">
      <button
        type="button"
        className={"btn sm" + (signedIn ? " ghost" : "")}
        disabled={busy}
        aria-busy={start.busy || undefined}
        onClick={() => {
          setErr(null);
          start.submit({ intent: "mcp-oauth-start", mcpId: mcp.id });
        }}
      >
        <GlyphSwap rest="user" alt="loader" on={start.busy} spinAlt />
        {start.busy ? "Starting sign-in…" : oauth?.status === "needs_sign_in" || !oauth ? "Sign in" : "Sign in again"}
      </button>
      {(signedIn || oauth?.status === "expired") && (
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          aria-busy={signOut.busy || undefined}
          onClick={() => {
            setErr(null);
            signOut.submit({ intent: "mcp-oauth-sign-out", mcpId: mcp.id });
          }}
        >
          <GlyphSwap rest="x" alt="loader" on={signOut.busy} spinAlt />
          {signOut.busy ? "Signing out…" : "Sign out"}
        </button>
      )}
      {link && (
        <a className="btn sm" href={link.url} target="_blank" rel="noopener noreferrer">
          <Icon name="ext" />
          {link.issuer ? `Continue at ${link.issuer}` : "Continue to the sign-in page"}
        </a>
      )}
    </span>
  );
}

/**
 * Ruling 469: the editor's OAuth sign-in, beside the pasted credential. "Sign
 * in" asks the server to discover the server's authorization server, register
 * Viberr there and hand back the authorization URL; the admin opens it in a
 * new tab (a link, so no popup blocker stands in the way) and approves Viberr
 * on the server's own page. The callback tab seals the tokens and says it can
 * be closed; this page revalidates on the resource event it publishes, so the
 * status line below turns to "signed in" by itself. "Sign out" revokes the
 * tokens at the server when it offers revocation and drops them here.
 */
export function McpSignIn({ mcp }: { mcp: McpView }) {
  const oauth = mcp.oauth ?? null;
  const [err, setErr] = useState<string | null>(null);
  // The authorization URL, and the sign-in state it was fetched against: once
  // that state moves (the callback landed, or the admin signed out), the link
  // has done its job and goes away.
  const [pendingLink, setPendingLink] = useState<{
    url: string;
    issuer: string | null;
    from: string;
  } | null>(null);
  const stateKey = signInStateKey(oauth);
  const start = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.authorizeUrl) setPendingLink({ url: d.authorizeUrl, issuer: d.issuer ?? null, from: stateKey });
    },
  });
  const signOut = useOrgAction();
  const link = pendingLink && pendingLink.from === stateKey ? pendingLink : null;
  const signedIn = oauth?.status === "signed_in";
  const status = signInStatus(oauth);
  const busy = start.busy || signOut.busy;
  return (
    <div className="field">
      <span className="flabel" id="mcp-oauth-label">
        OAuth sign-in <span className="fhint">for a server that asks for one</span>
      </span>
      <span className="fhint" role="status">
        {status}
      </span>
      {oauth?.status === "expired" && oauth.reason && <span className="fhint mono">{oauth.reason}</span>}
      {signedIn && <McpGrant scope={oauth?.scope ?? null} />}
      <McpSignInActions
        mcp={mcp}
        oauth={oauth}
        signedIn={signedIn}
        busy={busy}
        start={start}
        signOut={signOut}
        link={link}
        setErr={setErr}
      />
      {link && (
        <span className="fhint">
          Approve Viberr there. That tab says when it is done, and this editor updates by itself.
        </span>
      )}
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
      <div className="def-note">
        <Icon name="lock" />
        <span>
          Viberr registers itself with the server, you approve it on the server&apos;s own
          sign-in page, and Viberr keeps the tokens sealed and renews them. Agent runs reach
          the server through Viberr&apos;s MCP gateway and never see a token.
        </span>
      </div>
    </div>
  );
}
