-- F10-05: enforce ONE active delivering ("primary") run per task at the DB
-- layer.
--
-- The run service preflight-checks for a live delivering run before its
-- expensive async setup (repo clone, adapter start), then inserts the run only
-- afterward. Two racing dispatches can both pass that check during their awaits
-- and both insert, creating two delivery slots fighting over one workspace/git
-- index. This partial unique index makes the second insert fail atomically;
-- startRun translates the constraint violation into a 409 conflict.
--
-- Only queued/running PRIMARY runs are constrained. Operator and reviewer runs,
-- and any terminal state (finished/error/interrupted), are unconstrained — a
-- resume after the prior run ended does not conflict, and supporting/reviewing
-- runs are read-only and may run concurrently.
CREATE UNIQUE INDEX idx_agent_runs__one_delivering
  ON agent_runs (project_slug, task_key)
  WHERE kind = 'primary' AND state IN ('queued', 'running');
