import { useEffect, useRef } from "react";
import { data, Form } from "react-router";
import type { Route } from "./+types/org.users";
import { assertCsrf } from "~/server/auth/csrf.server";
import { generateTempPassword } from "~/server/auth/password.server";
import { requireAuth, requireRole } from "~/server/auth/require-user.server";
import {
  createUser,
  enableUser,
  disableUser,
  resetPassword,
} from "~/server/auth/user-admin.server";
import { findUserById, listUsers } from "~/server/auth/user-store.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { USER_ROLES, type UserRole } from "~/shared/mapping/user.server";
import { Avatar, initialsOf } from "~/ui/avatar";
import { CsrfInput } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";

/**
 * TEMPORARY admin surface — TO BE REPLACED IN PHASE 9 by the real
 * org-settings port (design/html-app/app/org-settings.jsx). This minimal
 * page exists so phase-2 user management (create / reset password /
 * disable / enable) is reachable and testable end-to-end. It deliberately
 * reuses existing design-system classes only; no new CSS.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Viberr — Org users (temporary)" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireRole(request, "admin");
  return { users: listUsers(getDb()).map(toClientUser) };
}

function toClientUser(u: ReturnType<typeof listUsers>[number]) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    title: u.title,
    role: u.role,
    idp: u.idp,
    avatarTone: u.avatarTone,
    disabled: u.disabled,
    pwresetRequired: u.pwresetRequired,
    lastLoginAt: u.lastLoginAt,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = requireRole(request, "admin");
  const auth = requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, auth.sessionId, formData);

  const intent = String(formData.get("intent") ?? "");
  const actor = { userId: admin.id, label: admin.email };

  try {
    if (intent === "create") {
      const tempPassword = String(formData.get("tempPassword") ?? "").trim();
      const role = String(formData.get("role") ?? "member") as UserRole;
      const user = createUser(
        db,
        {
          email: String(formData.get("email") ?? "").trim(),
          name: String(formData.get("name") ?? "").trim(),
          role: USER_ROLES.includes(role) ? role : "member",
          // Blank temp password = passwordless account (OAuth whitelist only).
          tempPassword: tempPassword.length > 0 ? tempPassword : null,
        },
        actor,
      );
      return data({
        notice: tempPassword
          ? `Created ${user.email} (${user.role}) — they must change the temp password at first sign-in.`
          : `Created ${user.email} (${user.role}) — passwordless; they sign in via GitHub/Google once whitelisted (already done by creating them).`,
        error: null,
      });
    }

    const userId = String(formData.get("userId") ?? "");
    const subject = findUserById(db, userId);
    if (!subject) {
      return data({ notice: null, error: "No such user." }, { status: 404 });
    }

    if (intent === "reset-password") {
      const tempPassword = generateTempPassword();
      resetPassword(db, userId, tempPassword, actor);
      return data({
        // Shown ONCE to the admin so they can hand it over out-of-band.
        notice: `Temporary password for ${subject.email}: ${tempPassword} — they must change it at first sign-in.`,
        error: null,
      });
    }
    if (intent === "disable") {
      disableUser(db, userId, actor);
      return data({ notice: `${subject.email} disabled.`, error: null });
    }
    if (intent === "enable") {
      enableUser(db, userId, actor);
      return data({ notice: `${subject.email} enabled.`, error: null });
    }
    return data({ notice: null, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (isAppError(error)) {
      return data(
        { notice: null, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
  }
}

export default function OrgUsers({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { users } = loaderData;
  const notice = actionData?.notice ?? null;
  const error = actionData?.error ?? null;
  const createFormRef = useRef<HTMLFormElement>(null);

  // Clear the create form after a successful create.
  useEffect(() => {
    if (notice?.startsWith("Created ")) createFormRef.current?.reset();
  }, [notice]);

  return (
    <main className="app-splash">
      <section className="panel" style={{ width: "min(760px, 94vw)" }}>
        <div className="panel-head">
          <h2>Org users</h2>
          <span className="right pill neutral">
            <span className="pdot" />
            temporary admin page
          </span>
        </div>
        <p className="detail-line">
          Minimal user management until the real org settings arrive in phase
          9. Creating a user whitelists them for GitHub / Google sign-in.
        </p>

        {notice && (
          <div className="cred-warn">
            <Icon name="check" />
            {notice}
          </div>
        )}
        {error && (
          <div className="login-err">
            <Icon name="alert" />
            {error}
          </div>
        )}

        <div className="member-list">
          {users.map((u) => (
            <div className="member-row" key={u.id}>
              <Avatar
                person={{ initials: initialsOf(u.name), tone: u.avatarTone }}
              />
              <span className="member-main">
                <span className="nm">
                  {u.name}
                  {u.title ? ` · ${u.title}` : ""}
                </span>
                <span className="em"> {u.email}</span>
              </span>
              <span className="idp-chip">
                {u.idp === "github" ? (
                  <Icon name="github" />
                ) : u.idp === "google" ? (
                  <span className="gmark">G</span>
                ) : (
                  <Icon name="lock" />
                )}
                {u.idp}
              </span>
              <span className={"pill sm " + (u.disabled ? "blocked" : "ready")}>
                <span className="pdot" />
                {u.disabled ? "disabled" : u.role}
              </span>
              {u.pwresetRequired && (
                <span className="pill sm input">
                  <span className="pdot" />
                  pw reset pending
                </span>
              )}
              <Form method="post" style={{ display: "inline-flex", gap: ".3rem" }}>
                <CsrfInput />
                <input type="hidden" name="userId" value={u.id} />
                <button
                  className="btn ghost sm"
                  name="intent"
                  value="reset-password"
                  type="submit"
                >
                  Reset password
                </button>
                {u.disabled ? (
                  <button
                    className="btn sm"
                    name="intent"
                    value="enable"
                    type="submit"
                  >
                    Enable
                  </button>
                ) : (
                  <button
                    className="btn danger sm"
                    name="intent"
                    value="disable"
                    type="submit"
                  >
                    Disable
                  </button>
                )}
              </Form>
            </div>
          ))}
        </div>

        <Form method="post" ref={createFormRef} className="login-form">
          <input type="hidden" name="intent" value="create" />
          <CsrfInput />
          <div className="field-row">
            <div className="field">
              <label className="flabel" htmlFor="nu-email">
                Email
              </label>
              <input id="nu-email" name="email" type="text" className="mono" />
            </div>
            <div className="field">
              <label className="flabel" htmlFor="nu-name">
                Name
              </label>
              <input id="nu-name" name="name" type="text" />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="flabel" htmlFor="nu-role">
                Role
              </label>
              {/* ORCHESTRATOR RULING 2: surfaced org roles are admin|member
                  (viewer stays tolerated in schema + RBAC helpers only). */}
              <select
                id="nu-role"
                name="role"
                defaultValue="member"
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-button)",
                  padding: ".55rem .7rem",
                  background: "var(--surface)",
                  color: "var(--fg)",
                }}
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
            </div>
            <div className="field">
              <label className="flabel" htmlFor="nu-pw">
                Temp password (blank = OAuth-only)
              </label>
              <input id="nu-pw" name="tempPassword" type="text" className="mono" />
            </div>
          </div>
          <button className="btn primary" type="submit">
            <Icon name="plus" />
            Create user
          </button>
        </Form>
      </section>
    </main>
  );
}
