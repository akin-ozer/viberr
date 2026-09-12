Arda here — re-validation after the pass-36 fixes (the instance was just rebuilt on the fix branch). Do these in order, one tool call each, and paste every tool reply VERBATIM in your report (no paraphrase). Do not create tasks, resume goals, or start any agent run.

1. instance_health — paste the whole `toolchain` field.
2. update_agent_deployment on headlamp-clone: move the Code Reviewer back to backend codex, model gpt-5.6-luna, effort max. Paste the reply.
3. set_required_reviewers on headlamp-clone: the Code Reviewer is required at Agent Review. Paste the reply. Then get_project and paste its `requiredReviewers`.
4. update_agent_deployment on headlamp-clone: grant the operator (profileId operator) the same knowledge bases the Server Developer holds (kbs). Paste the reply.
5. A deliberate probe of the skill writer: call save_skill with name `escape-probe`, summary `Observer probe of the escaped-body writer`, and a body that is ONE JSON string whose line breaks are the two characters backslash + n — the string must contain literal `\n` sequences and no real newline, e.g. "---\nname: escape-probe\ndescription: Probe.\n---\n# Escape probe\n- one". Paste the reply verbatim. Do NOT retry with real newlines; the refusal (if any) is the evidence I need.
6. list_skills — confirm whether `escape-probe` exists.
