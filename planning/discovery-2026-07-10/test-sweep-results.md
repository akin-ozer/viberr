# Test Harbor — 20+ task live sweep (2026-07-11)

A dedicated hands-on validation sweep on the FIXED codebase (real Claude + Codex). Project
**test-harbor** (repo cc-devops-skills), members: arda=admin, elif=maintainer, murat=contributor,
selin=viewer, deniz=non-member. Multi-user auth via better-auth cookie jars + per-user CSRF.

Legend: ✅ pass · ⚠️ finding.

## RBAC & permissions
| # | Case | Result |
|---|---|---|
| TH-9 | viewer (selin) create-task | ✅ 403 denied, no task dir |
| TH-10 | contributor (murat) create-task | ✅ 200 → TH-1 |
| TH-11 | non-member (deniz) comment | ✅ 200, timeline entry carries `guest: true` (labeled) |
| TH-12a | contributor (murat) approval-boundary transition | ✅ 403 denied |
| TH-12b | maintainer (elif) same transition | ✅ 200 allowed |
| TH-9b | viewer (selin) rescan | ✅ 403 denied |
| TH-9c | contributor (murat) rescan | ✅ 403 denied (admin\|maintainer only) |
| TH-9d | maintainer (elif) rescan | ✅ 200 allowed |

## Ownership (user assignments)
| # | Case | Result |
|---|---|---|
| TH-7a | elif owner-take TH-1 (member self-service) | ✅ 200, `task.ownership.taken` audit |
| TH-7b | arda (admin) release-any | ✅ 200, `task.ownership.admin_released {forced:true}` |

## File-native tolerance
| # | Case | Result |
|---|---|---|
| TH-6 | malformed YAML frontmatter (direct file) | ✅ readiness floored `blocked`, 8 diagnostics incl. `frontmatter.invalid_yaml`; **#27 verified**: stage is empty with `unresolved_stage` diagnostic (NOT phantom "triage"); health stays ok |
| TH-6b | board renders the malformed task | ✅ **new**: unstaged-task banner ("1 unstaged task — fix the task file") with clickable TH-6 chip. Fixed a corner my #27 fix opened (orphan tasks were counted but invisible) |
| TH-7 | direct-file task, key mismatch (dir TH-7 vs frontmatter TH-999) | ✅ dir wins, `key_mismatch` error diagnostic, board shows "inconsistency risk" |

## Operator triage (chooses correctly, flags vague)
| # | Case | Result |
|---|---|---|
| TH-2 | well-scoped (.editorconfig) | ✅ recommend → Ready |
| TH-3 | vague ("make things nicer") | ✅ operator opened a scoping **packet**, no specialist assigned |
| TH-4 | well-scoped tester task | ✅ recommend → Ready |
| TH-5 | well-scoped (CODEOWNERS) | ✅ recommend → Ready |

## Operator chooses the CORRECT specialist (the flagship check)
| Task | Goal type | Operator assigned | Correct? |
|---|---|---|---|
| TH-1 | coding (LICENSE) | Developer (Codex) | ✅ |
| TH-2 | coding (.editorconfig) | Developer (Codex) | ✅ |
| TH-4 | validation/testing | **Tester** (Codex) | ✅ — operator discriminated the tester goal |
| TH-5 | coding (CODEOWNERS) | Developer (Codex) | ✅ |

## Agents do role-appropriate work + real delivery
| Task | What the agent actually did |
|---|---|
| TH-1 | Developer replaced LICENSE with MIT text + updated README's License link; branch reconciled to task.md |
| TH-4 | **Tester** wrote AND ran `scripts/check_skill_frontmatter.py`, reported "OK: 31 SKILL.md files…" with evidence — tester behavior, not developer |
| TH-2, TH-5 | Developers opened real PRs #11/#12; **pr.state = "review" (canonical)** — confirms the ping-pong fix live (not raw "open") |

## Agent capability RBAC
| # | Case | Result |
|---|---|---|
| TH-8a | create profile with 3 caps incl. `commit-push-branch: off` | ✅ persisted EXACTLY 3 caps (no permissive defaults) — **#37 verified**; `off` mode persisted, not dropped — old RBAC bug stays fixed |
| TH-8b | `commit-push-branch: off` → git-push deny threaded to run | ✅ mode persists + `resolveSpecialistDisallowedTools` maps it to `Bash(git push:*)` deny (unit-tested; deny specifier not visible in init envelope) |

## Board resilience (new fix)
- **Unstaged-task banner**: a malformed/unstaged task (TH-6) now shows a flagged banner with a clickable key instead of being silently absent from every column. Closes a corner the #27 fix opened. Typecheck clean, board filters test green.

## Reviewer verdicts, acceptance, operator escalation
| # | Case | Result |
|---|---|---|
| TH-20 | reviewer APPROVES (TH-2) | ✅ "Review passed" quality event → validation=healthy |
| TH-19 | reviewer REQUESTS CHANGES (TH-5) | ✅ "Changes requested" → validation=failing + **runtime quality notification fired** (#6 verified), fanned to admin+maintainer |
| TH-2-done | human accepts completion (TH-2) | ✅ stage=done, validation=healthy, pr=merged, completion event attributed to the human (human-only-Done) |
| TH-3 | vague goal → scoping packet | ✅ operator packet, no assignment |
| TH-14 | conflicting requirements → packet | ✅ operator opened "CSV vs JSON conflict" packet |
| TH-14b | resolve packet (redirect) → operator re-invokes | ✅ runs 1→2 (**#2 re-verified**: no stranding) |
| TH-11 | full-autonomy operator | ✅ auto-advanced ready→impl itself + assigned specialist (no human approval). Its codex specialist run then hit the **Codex usage quota** → errored; viberr degraded gracefully (run=error, timeline recorded, no crash) |

## Comment usage / routing / MCP / skills
| # | Case | Result |
|---|---|---|
| TH-10 | @developer mention → agent run | ✅ primary run 0→1 (mention routed to agent) |
| TH-13 | MCP echo round-trip (claude + stdio `everything`) | ✅ **#36 verified live**: `mcp__everything__echo("th-mcp-probe") → "Echo: th-mcp-probe"` (env-spread fix made the npx stdio spawn work; it failed before). Agent also flagged an embedded server-metadata instruction as possible injection — correct behavior |
| skills | only declared skills in agent context | ✅ (phase-4 introspection: operator system prompt has ONLY viberr-app-expertise, no deep-research/dataviz/blog) |

## Reviewers / secondary assignment
| # | Case | Result |
|---|---|---|
| reviewers | operator summons reviewer at review boundary | ✅ TH-2/TH-5 reviewer runs (claude) |
| reviewer add/remove | explicit assign-reviewer then remove-reviewer (TH-1) | ✅ count 0→1→0 |

## Codex / Claude parity (from viberr's eye)
| Aspect | Codex specialist | Claude specialist (TH-9) | Same? |
|---|---|---|---|
| run row | backend=codex, finished | backend=claude, finished | ✅ |
| timeline reply | agent:codex/… | agent:claude/… | ✅ same shape |
| delivery reconciliation | branch+PR captured, state "review" | branch TH-9 + PR #13 state "review" | ✅ |
| cost telemetry | token usage only | `$0.19` total_cost_usd | intentional asymmetry, both handled |

## Coverage vs the user's enumerated dimensions — ALL covered
user assignments ✅ · stage transitions (auto/approval/human) ✅ · reviewers ✅ · secondary
assignments ✅ · comment usage (non-member label, @mention routing) ✅ · RBAC triggering ✅ ·
operator behaving correctly (triage, correct specialist pick, vague→packet, redirect re-invoke,
one-comment brevity, auto-boundary, full autonomy) ✅ · agents doing their job (dev implements+PR,
tester writes+runs tests, reviewer verdicts) ✅ · MCPs work ✅ · skills correctly loaded (not
unrelated) ✅ · codex/claude parity ✅.

## Environment note
- 22 distinct scenario tasks created in **test-harbor** (left in place for inspection). Real PRs #9–#13
  now exist on github.com/akin-ozer/cc-devops-skills from the delivery loop — owner to merge/close.
- The **Codex ChatGPT-plan quota was exhausted** partway through (many codex dev runs); later runs
  route through Claude. viberr handles a backend quota error gracefully (run→error, no crash).

