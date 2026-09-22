# RBAC probe — pass 39 (2026-09-22)

Five real accounts created **by the controller** (`create_user` + `invite_member`), each with
a one-time password it relayed once, each forced to change it at first sign-in. Probed by
signing in through the real login form and POSTing the actual route intents — not by reading
the policy table.

Probe scripts: `rbac-probe.sh` (matrix), `accept.sh` (acceptance ceremony from the shell).

## The matrix, measured

Target: `AX-8`, a throwaway probe task. `403` = refused, `200` = performed.

| intent | admin (Nadia) | maintainer (Ravi) | contributor (Tomas) | viewer (Priya) |
|---|---|---|---|---|
| GET task / policy / agents | 200 | 200 | 200 | 200 |
| `comment` | 200 | 200 | 200 | 200 |
| `set-task-metadata` | 200 | 200 | 200 | **403** |
| `run-operator` | 200 | 200 | **403** | **403** |
| `accept-completion` | 200¹ | 200¹ | **403** | **403** |
| `force-accept` | **200** | **403** | **403** | **403** |

¹ Nadia's first `accept-completion` answered `409`; her `force-accept` then closed the task,
so Ravi's later `accept-completion` was a no-op on an already-terminal task.

Every row matches what the Policy page promises, including the two that matter most:
**force-accept is admin-only**, and **running agents is maintainer-and-above**.

## Non-member (Jonas Weber — a real signed-in user with no ax-clone membership)

| URL | non-member | a project that does not exist |
|---|---|---|
| `/projects/ax-clone` | 302 → `/board` | 302 → `/board` |
| `/projects/ax-clone/board` | **404** "No project at projects/ax-clone" | **404** same |
| `…/tasks/AX-1`, `/policy`, `/github`, `/agents`, `/activity`, `/review`, `/settings`, `/controller` | **404** ×8 | — |

Byte-identical to a slug that was never created. The project's existence does not leak, which
is exactly what the Policy page claims ("answers as if the project did not exist"). **Pass.**

## What force-accept wrote — the best record in the product

Nadia force-accepted `AX-8` **from Triage**, with no branch, no PR, no verdict and a live
operator run. Viberr wrote:

> **Completed with no changes** — Human acceptance recorded: **AX-8 completed with no
> changes**. Nothing was delivered and there was no pull request to merge: no `ax-8` branch
> exists on the remote, checked against `main` at `1ad45a081b8a` when this was accepted.
> **The completion did not claim this; the server verified it at acceptance.**
> Bypassed: Design to Build to Verify to Review skipped; the review gate; AX-8 is at Triage,
> not Review

…then, separately:

> **Interrupted by acceptance** — the run `run_jFQdLno2F9PW` (Operator) was still live when
> AX-8 was force-accepted; it was interrupted so a closed task spends nothing more, and no
> completion of it will re-invoke the operator here.

…and three refusals for the operator turns that arrived afterwards, each naming the reason
("AX-8 is closed (at its terminal stage) — no run was started, so nothing on this task has
been acted on").

Every bypassed gate named. The "no changes" claim verified by the server rather than trusted.
The in-flight run stopped so a closed task cannot spend. No finding here — this is the
behaviour the rest of the product should be measured against.

## Harness notes (not findings)

- The task comment box is a **contenteditable**, not a `<textarea>`; `form_input` cannot fill
  it and reports success anyway. Click and type.
- The comment intent's field is `text`, not `body`; a wrong field name answers `400`.
- The CSRF token is not an `_csrf` input in the SSR HTML — it rides the turbo-stream payload
  as `csrf\",\"<token>`. `csrf.py` in the scratchpad extracts it.
- A `Secure`-prefixed session cookie is stored fine by curl over http, but the sign-in API
  alone is not enough: a user with `pwresetRequired` is redirected to `/login` on **every**
  page until the password is changed through the login form's `set-password` intent. That is
  correct behaviour, not a lock-out — the login page is the one route that lets them through.
