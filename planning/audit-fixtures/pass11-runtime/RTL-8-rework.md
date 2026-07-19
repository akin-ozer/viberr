> Scope: Exercises revision-bound review verdicts for the RTL-8 pass-11 runtime audit.

# RTL-8 rework fixture

This inert fixture represents a reworked revision of a reviewable documentation change.
It contains no executable commands, runtime configuration, or application behavior.

## Revision binding

A review verdict applies only to the exact revision inspected by the reviewer. Reworking
this fixture changes the tree and requires fresh verdicts for the resulting revision.
Neither a rejection nor an approval from an earlier revision carries forward.

## Reworked revision state

The first revision intentionally omitted its required style completion marker and received
a revision-bound rejection. This reworked revision adds the marker, changes the tree, and
requires fresh verdicts. Earlier rejections and approvals remain stale for this revision.

Last reviewed: 2026-07-20
