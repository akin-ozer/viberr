import type { Route } from "./+types/_index";

// Placeholder route: replaced by the real Home surface in phase 4.

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Viberr" },
    { name: "description", content: "Governed AI software delivery." },
  ];
}

export default function Index() {
  return (
    <main className="app-splash">
      <section className="panel">
        <div className="panel-head">
          <h2>Viberr — foundation online</h2>
          <span className="right pill ready">
            <span className="pdot" />
            ready
          </span>
        </div>
        <p className="detail-line">
          Phase 1 scaffold is in place: design system, typed env, SQLite
          projections store, structured logging.
        </p>
        <span className="mono">
          react-router 7 · vite · better-sqlite3 (WAL) · zod 4
        </span>
      </section>
    </main>
  );
}
