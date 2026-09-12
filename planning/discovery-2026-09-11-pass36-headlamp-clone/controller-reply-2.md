All four accounts exist, three are seated on `headlamp-clone`, and the three standalone tasks are created. The operator has already picked the tasks up, so I didn't start extra runs.

**Temporary passwords.** Each works once, and the person must set a new password at first sign-in.

| Person | Email | Temporary password | headlamp-clone |
|---|---|---|---|
| Maya Lindqvist | maya@viberr.dev | `W6GeonoRHxyJ` | maintainer |
| Omar Haddad | omar@viberr.dev | `N95M2Njqvbm9` | contributor |
| Lena Fischer | lena@viberr.dev | `r56rG1yfyXoV` | viewer |
| Noah Park | noah@viberr.dev | `UUxenE7LogUj` | not a member |

All four are org members, not admins. Noah has no seat, so the project won't be visible to him.

One thing to know: as maintainer, Maya can move tasks and run agents on this board. I haven't checked whether a maintainer can also approve the Agent Review → Merge Approval step. If you want to be the only approver, watch for that.

**Standalone tasks.** None of them waits on anything. Each gets its own branch and PR, and its done condition says the branch may change only the files it names.
- **HLC-6**, LICENSE (Apache-2.0) and CONTRIBUTING.md: in Building. The LICENSE must match the official Apache text exactly.
- **HLC-7**, docs/architecture.md: in Ready to Build. The reviewer checks every API route and error code against the spec.
- **HLC-8**, .editorconfig and PR template: in Ready to Build. The template carries all ten review checklist items and the rule that a review applies only to the commit it covered.

With HLC-1 still in Building, that makes four tasks in flight at once. All three are waiting on an agent, and I haven't confirmed that a developer run has started on any of them yet.

**What I couldn't do, and conflicts to know about**
- **No test-and-build gate on these three:** it doesn't exist on `main` until HLC-1 merges. Their proof is limited to the files each one changes plus the reviewer's approval.
- **The spec knowledge base has no architecture document.** HLC-7 builds the architecture from the spec plus the engineering standards, and is labelled as the planned v1 architecture.
- **Overlap with a later link:** the packaging link (goal-5 link 6) currently also creates docs/architecture.md. Once HLC-7 merges, that link should update the file instead of creating it. I can rewrite that link now if you want.
- **API documentation in two places:** the spec also expects the API contract in docs/api.md. After HLC-7 it will live in docs/architecture.md too, so later API changes need to update both. I can add that to the affected links.
