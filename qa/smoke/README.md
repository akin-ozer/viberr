# Smoke pass notes

This directory records concise evidence from smoke runs of Viberr workflows. Pass-note files summarize what a run exercised and identify the task and people associated with it; other files in the directory may provide task-specific evidence or executable checks.

## File names

Name a new pass note `pass<NN>-<topic>.md`, where `<NN>` is the pass number and `<topic>` is a short, lowercase, hyphen-separated description of the workflow. For example: `pass18-governed-delivery.md`.

Task-key files such as `VIB-1.md` are supporting evidence, not pass notes, and do not define the pass-note format.

## Pass-note structure

Use these elements in order:

1. **Title:** An H1 in the form `# Pass-<NN> <topic> smoke`. It names the pass and the smoke scenario; a qualifier such as `live` may appear before `smoke` when relevant.
2. **Purpose:** A single `Purpose:` sentence describing what the run records or confirms.
3. **Metadata:** A bullet list containing `Task key` and `Date` (`YYYY-MM-DD`). Add fields such as `Delivering agent profile` or `Verified by` only when they apply.

Pass notes do not use front matter. Keep them brief and add no empty section headings.

## Template

```markdown
# Pass-<NN> <topic> smoke

Purpose: <what this smoke run records or confirms>.

- Task key: <KEY-123>
- Date: <YYYY-MM-DD>
- Verified by: <name>
```

Remove optional metadata lines that do not apply.

<!-- pass-18 drift probe: added after review -->
