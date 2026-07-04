import { Form } from "react-router";
import type { Route } from "./+types/_index";
import { requireUser } from "~/server/auth/require-user.server";
import { Avatar, initialsOf } from "~/ui/avatar";
import { CsrfInput } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";

// Small authenticated landing — replaced by the real Home surface in
// phase 4. Requires login; shows the signed-in identity + sign out.

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Viberr" },
    { name: "description", content: "Governed AI software delivery." },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = requireUser(request);
  return { user };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  return (
    <main className="app-splash">
      <section className="panel">
        <div className="panel-head">
          <h2>Signed in to Viberr</h2>
          <span className="right pill ready">
            <span className="pdot" />
            {user.role}
          </span>
        </div>
        <span className="who-chip">
          <Avatar person={{ initials: initialsOf(user.name) }} lg />
          <span>
            <span className="nm">{user.name}</span>
            <div className="sub">
              {user.title ? `${user.title} · ` : ""}
              {user.email}
            </div>
          </span>
        </span>
        <p className="detail-line">
          Auth &amp; org foundations are online. The Home surface arrives in
          phase 4{user.role === "admin" ? (
            <>
              {" — until then, admins can manage users at "}
              <a href="/org/users" className="linkish mono">
                /org/users
              </a>
              .
            </>
          ) : (
            "."
          )}
        </p>
        <Form method="post" action="/logout">
          <CsrfInput />
          <button className="btn" type="submit">
            <Icon name="arrow" />
            Sign out
          </button>
        </Form>
      </section>
    </main>
  );
}
