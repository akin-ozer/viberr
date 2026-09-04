# Prompt for the fix-phase session

Paste everything in the fenced block below into a fresh session opened on this repo. It
assumes the branch `pass34/findings` (pull request #277) is merged or checked out, so
`planning/discovery-2026-09-03-pass34-jira-clone/` is on disk.

```
/goal implement the pass 34 findings. The discovery run is already done: I had viberr build a
jira clone entirely through its own machinery — the controller set the project up, operators
triaged, specialists wrote specs and scaffolded a Next.js app and reviewed each other over real
pull requests on akin-ozer/jira-clone, and a session watched every surface as four different
roles. It produced 31 findings and a very detailed plan, all of it under
planning/discovery-2026-09-03-pass34-jira-clone/. Read SUMMARY.md first, then FINDINGS.md (the
ledger, with root cause and live evidence per finding), then QUESTIONS.md (my answers, Q34-1 to
Q34-15, they are binding), then TODO.md which is the actual spec: 53 items in three bands, each
one carrying the root cause at file:line as the code stood when it was written, the mechanism,
the callers that were swept, the tests with the exact source edit that must make each one go
red, and the docs page it changes. TESTPLAN.md has 62 validation steps, unit and live, already
ordered so the live subjects don't destroy each other's preconditions. Every item in TODO.md was
written by an agent that read the code and then refuted by an adversarial critic whose
corrections are folded in and marked inline, so treat the plan as well-founded but not sacred —
if the code contradicts it, the code wins and you tell me what changed and why.

Work in the order TODO.md's "Order of work" section fixes: shared leaves and schemas first,
then the server leaves, then the github delivery core, the runtime and failure classification,
the dependency model, stage eligibility, acceptance and packets, the controller and ownership,
and the remaining UI, copy and docs. The headline is F34-11: any rework or conflict fix on a
task that already has an open pull request is never pushed, so a reviewer approves a revision
github has never seen, acceptance refuses with "rebase and re-review" and the operator ends up
asking a human to push by hand. That one is the wall the whole pipeline hit, three separate
times, so start there once the leaves are in. Rulings 128 to 144 are drafted at the bottom of
TODO.md ready to paste into docs/architecture/decisions.md — record them as you implement the
items that carry them, not at the end.

Validate as you go, not at the end. After each part: run the targeted tests, prove every canary
by actually breaking the source and watching it go red before you restore it (a test you didn't
canary doesn't count), then rebuild the container and use the app in the browser like a person
would — screenshots of the surfaces you changed, light and dark, desktop and mobile, and check
that what viberr shows matches what actually happened on disk, in the projections, in the audit
log and on github. The jira-clone project is still live in the container with 16 tasks in
exactly the states the findings describe: JC-6 has a QA to Review card pending on open PR #13,
JC-5 is stranded at QA with an unpushed rework, JC-7 and JC-9 are held behind the goal-1
foundation, JC-10 and JC-12 have blocked packets, JC-15 has an input packet, JC-16 was just
created by a goal chain, and JC-11, JC-13 and JC-14 have approved specs with open PRs. That
project is your live validation subject — TESTPLAN.md says which task proves which fix. When
the fixes land, let the same project keep building itself and see whether the wall is actually
gone: a rework should reach its own PR without me closing anything by hand.

Some traps that cost the discovery session real time. Never read the container's projection
database from the host, it crashed the container once — read it in-container with docker exec
and node:sqlite readOnly. The typecheck gate is `npm run typecheck`, never a bare tsc, because
the script runs react-router typegen first and .react-router/ is gitignored. Resolving a
decision packet in the UI is two clicks, the option card and then "Confirm decision", and an
edit_goal option opens the goal editor prefilled with the option's own text. The dock is already
open sometimes, so check .dock[data-open] before you click the launcher or you'll close it. The
copy-ban lint bans em and en dashes and "govern*" in rendered copy, and app.css has its own
integrity gate. The five-hour account limit killed twelve runs in two waves during discovery, so
if runs start failing all at once that's probably what it is, and F34-1 is precisely about
viberr not being able to say so.

Ask me product design questions whenever the plan leaves a real fork, with the background on why
you're asking so I can decide properly — you don't have to prepare them in advance, ask when you
hit them. Two are already answered and folded in: the operator may switch a task's delivering
agent however it judges best (Q34-14), and the github workflow scope stays optional but gets
disclosed at attach time and refused before the push (Q34-15).

You may not cut corners and you may not defer to future work. We are preprod: no migrations, no
backwards compatibility, you are allowed to break things, and you are allowed and encouraged to
change tests in critical ways where they pin the wrong behaviour. Every fix ships a test that
can actually go red and the docs page that describes it, in the same change. When everything is
in, run the full gates — lint, typecheck, test, build, then e2e with docker — then walk
TESTPLAN.md end to end and show me the evidence. Open a PR on akin-ozer/viberr when the work is
complete and validated; another model will review your code afterwards. I want the work done end
to end, and you are encouraged to iterate as much as you need to get there.
```
