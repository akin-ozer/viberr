# Getting started

> From nothing to a task's first agent run: install, first sign-in, the setup checklist,
> a first project and task, inviting people, running from source, and what to change
> before real users arrive. Each step links to the page with the full detail.
> Source of truth: `compose.yml`, `.env.example`, `app/server/auth/seed-admin.server.ts`,
> `app/server/seed/seed.server.ts`, `app/features/home/setup-checklist.tsx`,
> `app/features/home/new-project-modal.tsx`, `app/features/profile/*`.
> Verified against `main` @ `d423716` (2026-10-07).

## 1. What you need

- **To run it:** Docker with Compose 2.24 or newer. That is the supported install: one
  container, one named volume, no external database.
- **To run agents:** each person who owns tasks connects their own Claude account
  (Claude Pro/Max, or an Anthropic Console API key) or Codex account (a ChatGPT sign-in,
  an OpenAI API key, or a ChatGPT workspace access token). There is no shared instance
  credential: a run bills the task's owner (ruling 127).
- **To deliver code:** a GitHub repository and a personal access token that can push
  branches and open pull requests to it. A board that delivers results (files saved on
  each task, no code) needs none.
- **To work on Viberr itself:** Node.js 26 or newer and npm (§7).

## 2. Install with Docker

```sh
git clone https://github.com/akin-ozer/viberr.git && cd viberr
docker compose up
```

That is the whole install (ruling 504). The first `up` builds the image, creates the
store volume `viberr-data`, generates the session secret and the encryption key into the
store, and starts the app on <http://localhost:3000>. No `.env` file is needed.

The log prints the bootstrap admin's credentials once, on a line marked
`VIBERR BOOTSTRAP ADMIN`:

```text
VIBERR BOOTSTRAP ADMIN, email: admin@viberr.dev password: <one-time password> …
```

Running in the background instead (`docker compose up -d`), read it with
`docker compose logs app | grep "VIBERR BOOTSTRAP ADMIN"`. Sign in as `admin@viberr.dev`
with that password; Viberr asks you to choose your own before anything else. To use a
different email or a password you choose, set `VIBERR_SEED_ADMIN_EMAIL` and
`VIBERR_SEED_ADMIN_PASSWORD` in a `.env` before the first `up`; the bootstrap runs only
while the users table is empty.

Useful from here on:

| Command | What it does |
|---|---|
| `docker compose up -d --build` | Rebuild after pulling a new version and restart |
| `npm run deploy` | The same, stamped with the git revision and verified against `/resources/health` (ruling 345) |
| `docker compose logs -f app` | Follow the structured JSON log |
| `docker compose down` | Stop; the store volume is kept |
| `docker compose down -v` | Stop **and delete the store**: every project, credential and sign-in |

Example content for agents is optional, and is one command run while nothing holds the
store's writer lock (before the first `up`, or after `docker compose down`):
`docker compose run --rm app npm run seed`. It adds three example knowledge bases
(architecture notes, API contracts, deploy runbooks), four skills (conventional commits,
Terraform review, API design, a changelog writer) and the `@viberr.dev` domain to the
Google sign-in allowlist; remove that domain in *Instance settings → Sign-in & SSO* if you
enable Google sign-in. A seed that finds the users table empty also creates the bootstrap
admin, with `VIBERR_SEED_ADMIN_PASSWORD` or else the development default
`viberr-dev-2828`, so set the variable on any instance other people can reach.

## 3. First sign-in: the setup checklist

Home opens on **Finish setting up**, a numbered list of what this instance and you still
need (ruling 532). Each step's button opens the place where it is done, and the card leaves
once every step is done. An org admin sees four steps; a member sees the last two.

1. **GitHub** (org admin). *Instance settings → GitHub connections → New connection*. Paste
   a token; it is validated before anything is saved, and validation never writes to your
   repository. Tokens are encrypted at rest with the instance's encryption key.
   - A **fine-grained token**: resource owner is the account or organization that owns
     the repository; grant it that repository with **Contents: Read and write**,
     **Pull requests: Read and write** and **Metadata: Read-only**. To let Viberr create a
     project's repository for you (ruling 462), also grant **Administration: Read and
     write** on all repositories.
   - A **classic token** with the `repo` scope also works, and validates more precisely.

   Skip this step if every board will deliver results rather than code. Full detail:
   [domain/github-delivery.md](domain/github-delivery.md).
2. **Your own account** (org admin). `admin@viberr.dev` is the instance's default account,
   not a person's. *Instance settings → Users & access → Allow access* creates an account
   for you (choose Admin), shows its one-time password once, and asks for a new one at its
   first sign-in. Sign in as yourself from now on. Viberr sends no email: hand each person
   their one-time password yourself.
3. **Claude or Codex** (everyone who will own tasks). *Profile → Agent accounts*:
   - **Claude:** "Sign in with Claude" (a Pro or Max subscription), "Sign in with
     Console", or paste a Console API key (`sk-ant-…`).
   - **Codex:** "Sign in with ChatGPT" (a device-code sign-in), paste an OpenAI Platform
     API key, or paste a ChatGPT workspace access token.

   A hosted sign-in is run by the vendor's own CLI, and the credential it writes stays in
   your own runtime home on the server; Viberr never reads or stores your sign-in token.
   A pasted key is sealed in the database and only ever reaches the runs you pay for. You
   can keep several accounts per backend and switch with **Runs use** (ruling 507). If
   ChatGPT reports that device-code authorization is not enabled, ask your workspace admin
   to enable it, or paste a key instead. Detail:
   [operations/deployment.md](operations/deployment.md#agent-accounts-are-per-person-ruling-127).
4. **First project.** *New project* on Home asks for:
   - a **name** and a **key** (the task-key prefix, `WEB` gives `WEB-1`, `WEB-2`, …);
   - **what the board delivers**: *Software* (a GitHub connection and a repository, or
     "Connect the repository later") or *Results · no code* (each task's deliverable is
     the files its agent saves on the task; a repository is optional, for agents to
     read);
   - an **agent policy preset**: *Strict human-gate*, *Balanced · recommended*, or
     *Autonomous within policy*. Completion stays human-authorized under all three; the
     one exception, a direct completion grant under *Autonomous within policy*, is
     disclosed on the Policy page.

   The board starts on the *Standard · 5 stages* workflow (Triage → Ready → In Progress →
   Review → Done) with the built-in Operator, Developer and Reviewer agents deployed.
   Stages, boundaries, roles and agent capabilities are all editable in *Project
   settings*, *Policy* and *Agents*.

## 4. Your first task

1. Open the board and press **New task**. Write the goal the way you would brief an
   engineer: what to change, why, and how you will know it is done. You become the task's
   owner, so its agent runs bill your account.
2. The **Operator** starts as soon as the task exists. It reads the task and the
   repository, scopes the goal, and dispatches the Developer, then the Reviewer. Follow it
   live on the task page: the run strip and its console show each agent's output as it
   streams.
3. When a person has to decide something, the operator opens a **decision packet** on
   the task and the bell notifies you. Answer it there. To steer at any time, comment on
   the task; start the comment with `@operator` to address the operator directly.
4. On a software board, the server (never the agent) pushes the task's branch and opens
   the review pull request. The Reviewer's verdict is bound to the revision it reviewed.
5. **Accepting is yours.** Moving a task to Done merges its pull request (or, on a
   results board, accepts its saved files), and asks you to confirm first.

The **controller** is the other way in: the dock on every page (and `/controller`) is a
conversational agent that can answer questions about the instance and act for you,
within exactly your own permissions, such as "create a task on WEB to add rate limiting
to the login form". It runs on your own Claude account. Detail:
[domain/controller-and-epics.md](domain/controller-and-epics.md).

What each stage, boundary and packet means: [domain/task-lifecycle.md](domain/task-lifecycle.md)
and [domain/operator.md](domain/operator.md). The vocabulary is in
[product/glossary.md](product/glossary.md).

## 5. Bring in your team

- **Accounts.** *Instance settings → Users & access* allows a person in as an org
  `admin` or `member`, with a one-time password shown once.
- **Projects are members-only.** A project admin adds people in *Project settings* with a
  project role: `admin`, `maintainer`, `contributor` or `viewer`. The full permission
  matrix is in [domain/auth-and-rbac.md](domain/auth-and-rbac.md#3-roles).
- **Single sign-on (optional).** *Instance settings → Sign-in & SSO* configures GitHub and
  Google sign-in (or seed them from `GITHUB_OAUTH_CLIENT_ID/SECRET` and
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`; the in-app settings win). Callback URLs are
  `https://<host>/api/auth/callback/github` (scopes `read:user user:email`) and
  `https://<host>/api/auth/callback/google` (scopes `openid email profile`). Sign-in is a
  whitelist: it succeeds only for an email that already has an enabled Viberr account, or,
  for Google, an email in a domain an admin allowed (those accounts are created at first
  sign-in).
- **Each person connects their own agent account** (§3, step 3). A task whose owner has
  none cannot run agents, and says so.

## 6. Before real users arrive

- **TLS.** The app speaks plain HTTP on port 3000. Put a TLS-terminating reverse proxy in
  front, then set `BETTER_AUTH_URL` to the public `https://` origin and
  `VIBERR_TRUST_PROXY=1` in `.env`. Skipping either gives a sign-in loop, not an insecure
  but working app. Example proxy configs:
  [operations/deployment.md](operations/deployment.md#tls-and-the-reverse-proxy).
- **CPU ceiling.** One agent run can fork a test worker per CPU it sees. On a machine
  someone also works on, set `VIBERR_CPUS` to roughly the core count minus 3.
- **Secrets.** The generated session secret and encryption key live in the store at
  `state/instance-secrets.json`, and a backup carries them. To manage them yourself, copy
  them into `.env` unchanged once anything has been sealed; a new key needs the rotation
  in [operations/configuration.md](operations/configuration.md).
- **Backups.** `npm run backup` takes a consistent copy (a raw copy of the live SQLite
  file can miss rows still in its write-ahead log). In the container:

  ```sh
  docker compose exec -T app npm run backup -- --out /tmp/viberr-backups
  docker compose cp app:/tmp/viberr-backups/. ./backups/
  ```

  Treat a backup as a secret. Restoring, and what a backup leaves out:
  [operations/deployment.md](operations/deployment.md#persistence-backup--restore).
- **Health.** `GET /resources/health` is an unauthenticated probe: `200` while the process
  answers (liveness), and with `?probe=readiness` `503` while any subsystem is degraded.
  Every field is explained in
  [operations/runbook.md](operations/runbook.md#health--liveness).
- **Upgrades.** `git pull && npm run deploy`. Migrations apply at boot and the volume
  carries the state; take a backup before a major upgrade. Schema changes edit one
  baseline rather than adding to a migration chain. At boot, an older database gets the
  columns, tables and indexes the release lists for it, and `notifications` is rebuilt
  when its `kind` CHECK lags and `user_backend_credentials` when it still has its
  one-account shape. The `projection schema drift` warning names, with its remedy, a
  column `task_projections` or `task_events` lacks (a manual `ADD COLUMN`) and a value one
  of four checked CHECK constraints refuses (a
  [re-baseline](operations/deployment.md#re-baselining-the-projection-database)). Any
  other drift is neither repaired nor reported, and file formats carry no back-compat
  promise. Check what changed before you upgrade an instance that holds real work.

## 7. Run from source

For working on Viberr itself (Node.js 26 or newer):

```sh
git clone https://github.com/akin-ozer/viberr.git && cd viberr
cp .env.example .env   # every variable is optional
npm ci
npm run seed           # baseline content and the bootstrap admin
npm run dev            # http://localhost:5173
```

Sign in as `admin@viberr.dev` with password `viberr-dev-2828`, or the
`VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` you set before seeding.
`npm run seed:demo` loads the demo board the route and e2e suites are written against
instead (sign in as `arda@viberr.dev` with the same password).

The dev server keeps its store in `./docker-data` (from `.env.example`; `./data` when the
variable is unset), separate from the container's volume. One process may hold a store at
a time: a second server, or a seed while the app runs, is refused by the writer lock.
Without the container's setuid launcher, agent runs start as your own OS user, and health
reports `agentIsolation: off`; that is for development only (ruling 460).

The gates, the code layout and the definition of done:
[development/contributing.md](development/contributing.md).

## 8. When something goes wrong

| Symptom | Where to look |
|---|---|
| Signing in loops back to the login page | `BETTER_AUTH_URL` and `VIBERR_TRUST_PROXY` behind a proxy (§6) |
| Lost the bootstrap password | Another org admin resets it in *Users & access*; on a fresh instance, `docker compose down -v` and start again |
| `npm run seed` (or `rescan`, `restore`) is refused | The app holds the store's writer lock; stop it first ([runbook](operations/runbook.md#the-single-writer-lock-and-cli-refusals)) |
| A task says it cannot run agents | It has no owner, or its owner has no connected Claude or Codex account |
| GitHub actions fail or say "no credential" | [runbook, GitHub / PAT issues](operations/runbook.md#github--pat-issues) |
| Something looks wrong in the board or a task | `npm run store:check`, then [runbook, Diagnostics](operations/runbook.md#diagnostics-a-task-looks-wrong--stuck) |
