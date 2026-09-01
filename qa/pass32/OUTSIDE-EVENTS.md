# Outside-events note

PASS32-KB-LOADED

When the reconciler in `app/server/github/github-reconciler.server.ts` finds that a task's PR was merged or closed directly on GitHub rather than through Viberr's accept flow, it records a divergence note on the task's timeline and notifies the task's watchers, without auto-advancing the task's stage, so a human has to close the loop by accepting the completion, moving the task to Done, or deciding to rework or archive it. An exception is a PR that was already accepted (merge pending) in Viberr and then gets closed externally without merging; that case is recorded as a neutral note rather than a divergence, since it simply explains that the pending merge can no longer be completed from Viberr.
