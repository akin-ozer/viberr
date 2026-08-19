# Pass-21 Probe Protocol

This directory holds the pass-21 live-test probes: tiny, reviewable changes
whose only job is to exercise the governed delivery pipeline end to end (task
creation, branch work, review, and merge) without touching the product itself.

## Purpose

Each probe is a minimal, deliberately low-risk change used to verify that the
pipeline — from task assignment through implementation, review, and delivery
— works correctly in practice. Probes are not features; they exist to prove
the process, not to ship functionality.

## Rules

1. Probe files live only under `planning/pass21-probe/`. Nothing outside this
   directory is part of the probe protocol.
2. Each probe file is small and self-contained — easy to read and review in
   full in under a minute.
3. Probes never touch application code, configuration, or any other part of
   the repository. A probe's diff should be confined entirely to this
   directory.
4. Every probe is logged in the table below when it is added.

## Probe log

| # | File | Description |
|---|------|-------------|
| 1 | `README.md` | This protocol document — the first probe entry. |
| 2 | out-of-band merge probe | VIB-7 |
