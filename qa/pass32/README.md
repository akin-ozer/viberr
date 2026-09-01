# Pass-32 QA conventions note

PASS32-KB-LOADED

This note restates the pass-32 QA conventions for anyone working in this directory.

1. Marker rule: every markdown file created or edited for a QA task must include the exact
   line `PASS32-KB-LOADED` right after its first heading, so reviewers can confirm the
   conventions were actually loaded.
2. Location rule: QA files belong under `qa/pass32/` in the repository, unless a task
   explicitly says to put them somewhere else.
3. Style rule: headings use sentence case, and prose should avoid em dashes.

## qa_echo tool output

Calling the `qa_echo` MCP tool with the text `VIB-1` returned the following output, quoted
verbatim:

```
PASS32-MCP-ECHO:VIB-1
```
