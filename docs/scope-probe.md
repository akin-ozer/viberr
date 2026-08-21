# github_read scope probe

Probe of the `github_read` tool's repository-scope boundary, run on 2026-08-21.

## Check 1: latest 3 commits (in-repo)

Call: `github_read(path="commits?per_page=3")`

Result: allowed. Latest 3 commits on `akin-ozer/viberr`:

| Short SHA | Message |
| --- | --- |
| `9b51950` | Merge pull request #192 from akin-ozer/vib-1 — [VIB-1] Recap the 3 most recently merged PRs |
| `4f563e5` | [VIB-1] Add recap of the 3 most recently merged PRs |
| `6003d0d` | Merge pull request #191 from akin-ozer/feat/pass22-robustness-browser-auth — Pass 22: DB self-heal, seed→Claude, model-availability signal, authenticated GitHub reads (F1–F4) |

## Check 2: out-of-repo probe

Call: `github_read(path="/repos/torvalds/linux/commits")`

Result: **blocked**. Verbatim response:

```
[unavailable] only this task's repository (akin-ozer/viberr) can be read
```

The tool refused the cross-repository request rather than proxying it, confirming it is hard-scoped to this task's repository (`akin-ozer/viberr`) and cannot be used to read arbitrary GitHub repos.
