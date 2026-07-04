import type { ReactNode } from "react";
import type {
  ProjectCredentialHealth,
  ScopeChip,
} from "~/server/secrets/pat-store.server";
import { Icon } from "~/ui/icon";

/**
 * THE credential card (github-view spec §7.12: one component, used by the
 * GitHub view now and Settings → RepoSettings in Phase 9, so the two can't
 * drift). Markup is the mock's `.cred-card` verbatim; the footer action
 * slot is the only variation point ("Fix in Settings" here, "Grant scope"
 * in Settings — this page currently renders both, see the phase report).
 *
 * States:
 * - source "pat" | "policy_display" → cred-top + scope chips + warn/ok
 *   footer (chips render the server verdicts directly — the mock's
 *   `s.ok || scopeGranted` hack is deleted per spec §7.2).
 * - source "none" → the settings-spec §7.11 degraded mode: a "connect
 *   credential" affordance instead of scope chips (reuses cred-warn).
 */

export type CredentialCardData = Pick<
  ProjectCredentialHealth,
  "configured" | "source" | "label" | "masked" | "scopes"
>;

export function CredentialCard({
  credential,
  onOpenTask,
  warnActions,
}: {
  credential: CredentialCardData;
  /** Opens the flagged task (the cred-warn `.keybtn`). */
  onOpenTask: (taskKey: string) => void;
  /** Right-aligned footer action slot (Fix in Settings / Grant scope). */
  warnActions?: ReactNode;
}) {
  if (credential.source === "none") {
    return (
      <div className="cred-card">
        <div className="cred-top">
          <Icon name="lock" />
          <span className="cred-name">No credential configured</span>
        </div>
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            No GitHub PAT is connected to this project — branch and PR sync
            stays offline until one is added.
          </span>
          {warnActions}
        </div>
      </div>
    );
  }

  const missing = credential.scopes.find((s) => !s.ok);
  return (
    <div className="cred-card">
      <div className="cred-top">
        <Icon name="lock" />
        <span className="cred-name">{credential.label}</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--faint)" }}>
          {credential.masked}
        </span>
      </div>
      <div className="scope-chips">
        {credential.scopes.map((s: ScopeChip) => (
          <span className={"scope-chip" + (s.ok ? "" : " miss")} key={s.id}>
            <Icon name={s.ok ? "check" : "alert"} />
            {s.id}
          </span>
        ))}
      </div>
      {missing ? (
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            Missing <code className="mono">{missing.id}</code> — PR status
            can't auto-sync after merge.
            {missing.flaggedTaskKey ? " Flagged on" : ""}
          </span>
          {missing.flaggedTaskKey && (
            <button
              type="button"
              className="keybtn"
              onClick={() => onOpenTask(missing.flaggedTaskKey!)}
            >
              {missing.flaggedTaskKey}
            </button>
          )}
          {warnActions}
        </div>
      ) : (
        <div className="cred-ok">
          <Icon name="check" />
          All required scopes granted. Secrets stay isolated from task
          records and timelines.
        </div>
      )}
    </div>
  );
}
