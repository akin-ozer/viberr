-- Phase 10 — audit, diagnostics, recovery + integration gaps.
--
-- users.github_handle: the GitHub login captured at OAuth sign-in time
-- (phase-9C decision 3 flagged that attribution relied on email alone).
-- Nullable; only populated for accounts that have signed in via GitHub.
ALTER TABLE users ADD COLUMN github_handle TEXT;
