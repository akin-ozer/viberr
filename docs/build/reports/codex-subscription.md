# Codex on a ChatGPT subscription — compose wiring + two real fixes

Goal: run agents via the Codex CLI's ChatGPT-plan login (keyless) inside the
container, and confirm Codex works end-to-end. Done — and verified with a real
Codex run through the app that produced a genuine repo analysis.

## compose.yml

Activated the Codex subscription path:

```yaml
environment:
  CODEX_HOME: /codex
  VIBERR_CODEX_USE_CLI_AUTH: "1"
volumes:
  - ${HOME}/.codex:/codex        # `codex login` on the host; read-write so the
                                 # SDK can refresh the OAuth token
```

`hasCredential("codex")` already treats `VIBERR_CODEX_USE_CLI_AUTH=1` as
available, and the adapter runs keyless (no API key) so the Codex SDK uses
`/codex/auth.json`. `health` now reports `codex: "real"`.

## Fix 1 — the Codex SDK REPLACES the child env (adapter was stripping it)

`createAdapters` passed `env: { CODEX_HOME }` to `new Codex({ env })`. But the
`@openai/codex-sdk` (v0.142) builds the spawned `codex` process env like:

```js
const env = {};
if (this.envOverride) Object.assign(env, this.envOverride);   // ← REPLACE
else for (const [k,v] of Object.entries(process.env)) env[k] = v;
```

So passing `{ CODEX_HOME }` alone would spawn `codex` with **only** CODEX_HOME —
no PATH, no HOME — breaking it. (The Claude SDK merges `{...process.env}`, which
is why Claude was fine.) Fixed with `codexSpawnEnv(codexHome)` which snapshots
`process.env` and forces `CODEX_HOME`, handed to the SDK as a complete env.
Locked with a unit test.

## Fix 2 — `gpt-5-codex` is rejected on a ChatGPT plan; default to `gpt-5.5`

The first real run reached the API and returned:

> `The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.`

So the subscription auth worked; the app's hardcoded default codex model
(`gpt-5-codex`, in 6 places) is API-key-only. Probed the account directly:

| model         | ChatGPT-plan login |
| ------------- | ------------------ |
| `gpt-5.5`     | ✅ works           |
| `gpt-5`       | ❌ rejected        |
| `gpt-5-codex` | ❌ rejected        |

Changed the codex default to **`gpt-5.5`** (valid on a ChatGPT plan AND with an
API key) across the curated model catalog (`defaultModel`), the new-profile
default, and every run/reply fallback. `gpt-5-codex` / `gpt-5` stay in the
picker, relabelled "(API key)".

## Confirmation (real end-to-end)

- **Binary**: `CODEX_HOME=/codex codex exec … "Reply with OK"` in the container
  authenticated via the mount and replied (model `gpt-5.5`).
- **App / SDK path**: deployed a codex specialist, engaged it as a reviewer on
  CTL-1, and hit Run. The run went `simulated=0`, `backend=codex`, real thread
  `019f3433`, `finished`, 2,048 output tokens — streaming `@openai/codex-sdk ·
  runStreamed()` — and produced a real analysis ("`containerless` is an
  early-stage Go CLI that provisions a local Kind cluster with Knative…", flagged
  the missing `go.mod`/tests and a port-forward process leak).

Gates: `npm run typecheck` clean · `npm test` **891/891** (+1 codexSpawnEnv test;
4 model-default expectations updated) · `npm run build` clean · container rebuilt,
`health.backends.codex = "real"`.

## Notes

- Benign log line at startup: `state db returned stale rollout path … /Users/
  …/.codex/sessions/…` — the mounted state db references host paths that don't
  exist at `/codex`; runs still succeed (new rollouts write under `/codex`).
- Don't set `OPENAI_API_KEY`/`CODEX_API_KEY` in `.env` for the subscription path
  — either would flip the adapter to API-key mode (and re-enable `gpt-5-codex`).
- The mount is read-write so the SDK can refresh the OAuth token; on Docker
  Desktop the uid-1000 container can read/write the host-owned files.
