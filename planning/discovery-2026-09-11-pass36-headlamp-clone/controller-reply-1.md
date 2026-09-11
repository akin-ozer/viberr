The setup is done and the first task is running. HLC-1 (repo scaffold) is in Building, and the operator started a Codex run for the Server Developer at 14:28:36. I didn't start a second one. Five goal chains hold 32 tasks. Required reviewers bound to a revision are the one piece I couldn't set up as a real server rule (explained under "Could not do").

**Project: `headlamp-clone` (task keys `HLC-n`)**
- Repo `akin-ozer/headlamp-clone`. GitHub reads as connected with `main` as the default branch. The repo was empty, so Viberr created `main` with a README commit `ad3180d`.
- Policy is "balanced", and every boundary is set explicitly:
  - Intake → Ready to Build: auto
  - Ready to Build → Building: auto
  - Building → Agent Review: auto (the operator pushes the branch and opens the PR)
  - **Agent Review → Merge Approval: you approve**
  - **Merge Approval → Shipped: human only (locked).** This is where you merge and accept.
- The product is a TypeScript monorepo: a Node server (Fastify + `@kubernetes/client-node`, reads your kubeconfig, listens on 127.0.0.1:4466) and a React + Vite web app. Build, lint and test use only npm and Vitest. Tests run against a fake Kubernetes API inside the test process, so no cluster is needed.

**Agents.** All four read back as Codex, gpt-5.6-luna, effort max.
- **Operator:** supervised. It triages, runs agents, moves tasks and opens decision packets. It pushes the branch and opens the PR, and keeps the branch up to date. It can only *recommend* acceptance. Web search is off.
- **Server Developer** (Building only): runs code, creates the branch, commits, comments, attaches evidence, web search. It can't open PRs, ask you directly, use a browser, read GitHub or give verdicts.
- **Frontend Developer** (Building only): same as the Server Developer, plus **browser**. It posts the screenshots as evidence attachments; the first is due on the Clusters home task.
- **Code Reviewer** (Agent Review only): runs code (needed to run the test suite), reads GitHub, gives verdicts, comments, attaches evidence. It can't create branches, commit, open PRs, ask you directly, search the web or use a browser.

**Resources**
- Knowledge base `headlamp-clone-spec`: `product-spec.md` and `api-contract.md`.
- Knowledge base `headlamp-clone-engineering`: `standards.md`.
- Skill `headlamp-clone-delivery`, granted to both developers.
- Skill `headlamp-clone-review-checklist`, granted to the reviewer.
- MCP server `context7` (library documentation), granted to both developers. It tested healthy (2 tools, 1200 ms) and needs no secret.
- Two one-off operator check-ins on HLC-1, at 15:29 and 16:59 UTC.

**Goal chains**

| Goal | Chain | Links | Link 1 task | Waits on |
|---|---|---|---|---|
| `goal-1` | Foundation | 7 | HLC-1 (running) | nothing |
| `goal-2` | Resource lists and detail views | 6 | HLC-2 (held) | goal-1 link 7 |
| `goal-3` | Logs, events and live updates | 6 | HLC-3 (held) | goal-1 link 4 |
| `goal-4` | YAML view, search and apply | 6 | HLC-4 (held) | goal-1 link 4 |
| `goal-5` | Actions, more kinds and release | 7 | HLC-5 (held) | goal-4 link 5 and goal-2 link 6 |

Chains 3 and 4 start in parallel as soon as the fourth Foundation task lands.

**Could not do, or done differently**
1. **Revision-bound required reviewers:** no tool or project setting exists for this. HLC-1 shows no required reviewers. The rule is written into each task's done signal, the reviewer's checklist, a note to the operator on HLC-1 and a check-in, but the server doesn't enforce it. If the project settings page has a required-reviewer option, set it there.
2. **Runtime check:** I have no shell, so I couldn't inspect the runtime image. I chose Node because Viberr's own agent backends run on it (an inference, not a check). HLC-1 has to record the real Node and npm versions and whether go, python3, docker and kubectl exist; if Node is below 20 or npm can't download packages, it opens a decision packet for you.
3. **Effort "max":** the tool docs say Codex only goes up to xhigh, but the server accepted and stored max on all four agents. I can't confirm the backend actually runs at max rather than mapping it down.
4. **Stock templates rewritten org-wide:** the stock Developer and Reviewer were auto-deployed and deployments can't be removed. I rewrote those two templates as Server Developer and Code Reviewer, so any future project will get these versions too.
5. **Extra capabilities I couldn't turn off:** a few permissions the product ships with have no switch (for example the developers' "move task to review" and the reviewer's "author test cases"). The reviewer also needs "run code or write to the repo" to run the tests; it can't commit or push, and its instructions forbid editing files.
6. **The operator gets no knowledge bases or skills:** it's a system profile I can't give resources to, so the rules it needs are in each task's text.
7. **Schedules only fire once:** they can only go on tasks that exist, and HLC-1 is the only live one.
8. **Eight merged today isn't guaranteed:** every task needs two actions from you (approving Merge Approval, then merging into Shipped). The realistic path is the 7 Foundation tasks plus HLC-3 and HLC-4.

Nothing was refused by permissions. You don't need to add any secret. When HLC-1 reaches Merge Approval, approve it and merge it on its task page in `headlamp-clone`.
