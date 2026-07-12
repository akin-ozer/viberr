-- 0008_org_resources: phase 9B (org settings — instance-level admin).
--
-- github_connections: org-level GitHub OWNER connections (org-settings
-- spec §3.1) — every project picks one at creation. The token itself lives
-- in the phase-7 `github_pats` table (AES-256-GCM at rest, validation
-- cache); this table binds an owner to that PAT row and carries the
-- org-level facts (default flag, repo count, expiry) captured at
-- validation time. Exactly one default is enforced in the server layer
-- (transactional set-default).
--
-- google_domain_allowlist: Google domain rows (§3.3). Managed here;
-- consulting it from the Google OAuth callback is a documented later-phase
-- wiring (the callback modules are outside 9B ownership).
--
-- org_knowledge_bases / org_mcp_servers / org_skills: metadata for the
-- agent-resource panels (§3.4–3.6). The kb/skill CONTENT is file-native —
-- real directories under ${VIBERR_DATA_ROOT}/kb/<dir>/ and /skills/<name>/
-- scanned from disk; only cadence/summary/timestamps live here. MCP
-- servers are pure config; `up` is the last initialize + tools/list verdict.
-- org_secrets holds encrypted values; MCP auth_json stores only explicit
-- HTTP-header / stdio-env names mapped to secret://org/<name> references.
--
-- Global agent profiles need NO table — they are the phase-3 template
-- files under agents/profiles/*.md (the org-template layer 9A consumes).

CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,                -- slugify(owner)
  owner TEXT NOT NULL UNIQUE,
  pat_id TEXT NOT NULL REFERENCES github_pats (id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0,
  repos_count INTEGER,                -- from GitHub at validation time
  expires_at TEXT,                    -- token expiry (ISO) when advertised
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_github_connections__default
  ON github_connections (is_default);

CREATE TABLE google_domain_allowlist (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,        -- normalized "@company.dev"
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL
);

CREATE TABLE org_knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,           -- folder under ${DATA_ROOT}/kb/
  refresh TEXT NOT NULL DEFAULT 'on change'
    CHECK (refresh IN ('manual', 'on change', 'nightly')),
  last_indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE org_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- slug
  transport TEXT NOT NULL CHECK (transport IN ('HTTP', 'stdio')),
  target TEXT NOT NULL,               -- endpoint (HTTP) or command (stdio)
  auth_json TEXT NOT NULL DEFAULT '{}', -- HTTP header / stdio env name -> secret://org/<name>
  tools_count INTEGER,                -- discovered tool count (NULL unknown)
  up INTEGER,                         -- 1 up · 0 down · NULL never probed
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Org-owned encrypted values referenced by MCP auth mappings. Loaders expose
-- only id/name/ref/suffix metadata; encrypted_value is opened only at the
-- execution boundary (an explicit MCP connection test or specialist spawn).
CREATE TABLE org_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  encrypted_value TEXT NOT NULL,
  value_suffix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE org_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- slug; folder ${DATA_ROOT}/skills/<name>/
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
