/**
 * Minimal "arrives in phase N" panel for workspace views whose real port
 * lands in a later phase (review/agents/policy/github/activity/settings).
 * Real routes — the rail has no dead links; the panel is one line of copy
 * on design-system classes only.
 */
export function PlaceholderView({
  title,
  phase,
  screenLabel,
}: {
  title: string;
  phase: number;
  screenLabel: string;
}) {
  return (
    <div className="board-wrap" data-screen-label={screenLabel}>
      <div className="board-head">
        <div>
          <h1>{title}</h1>
          <div className="sub">
            This surface arrives in phase {phase} — the route and rail entry
            are already real.
          </div>
        </div>
      </div>
    </div>
  );
}
