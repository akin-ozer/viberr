-- 0010_run_agent_identity: carry the agent's identity on each run row.
--
-- Every resume of an agent's session mints a NEW agent_runs row (a fresh
-- thread id sharing the provider session), so the Agent-logs picker used to
-- show one entry PER RUN, each labeled by the backend ("Claude Code"). The
-- run projection now GROUPS runs per agent and labels each group by the
-- agent's own name ("dev", "Operator", a consultant's name).
--
-- agent_name        the deployed profile's display name (e.g. "dev", "Operator").
-- agent_profile_id  the deployed profile id — the stable grouping key so all of
--                   an agent's resume runs collapse into one picker entry.
--
-- Both are NULLABLE: seed rows and historical rows predate this column and
-- carry null. The projection falls back to the backend WHO_NAME for the label
-- and to the run's role for the grouping key when they are null.

ALTER TABLE agent_runs ADD COLUMN agent_name TEXT;
ALTER TABLE agent_runs ADD COLUMN agent_profile_id TEXT;
