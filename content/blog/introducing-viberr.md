---
title: "Introducing Viberr: a governed operating layer for agent-driven delivery"
date: 2026-09-08
summary: "Viberr is a task-coordination product where an operator agent drives specialist agents through a governed workflow, so coding agents can do real delivery work while engineers keep control of flow, review and acceptance."
---

# Introducing Viberr

Coding agents have become genuinely useful. What has not kept pace is the machinery
around them. A capable agent can write a change, run the tests and explain itself — but
the moment more than one agent is working, and more than one human cares about the
result, the work scatters across chats, branches and status labels that nobody owns.

Viberr is our answer to that gap: a multi-user web application for governed AI software
delivery, built for small AI-forward engineering teams. Persistent agents do the delivery
work; engineers keep control of flow, review and acceptance. The unit of coordination is
the **task**, and the task is the contract everyone works against.

## The problem

Task systems are human-native. They assume humans are the default workers and that AI
helps at the edges — a suggestion here, an autocomplete there. That assumption breaks
as soon as agents own execution. Persistent agent work needs somewhere durable to live:
a place that records what the goal is, who decided what, which branch carries the change,
what evidence backs a claim, and which boundary the work is currently waiting on. Without
that, "what is this agent doing and who said it could?" has no answer you can point at.

Viberr inverts the responsibility model. Agents own task execution. Engineers own
movement, approvals and quality boundaries. And the task file — readable markdown holding
state, execution context, decisions, timeline and evidence — is the durable contract
between humans, agents and GitHub. Canonical truth is files, not a database; the app
watches them, parses tolerantly so malformed input becomes a readable diagnostic rather
than a crash, and projects them into SQLite for fast reads.

## How it works

Each active task gets one **operator** agent. The operator does not do the implementation;
it coordinates. It triages the goal, dispatches deployed specialist agents to do the stage
work, opens a decision packet when a human has to decide something, recommends or performs
transitions where policy allows, and decides when the work is ready to be delivered.
Specialists work in isolated git workspaces on the task-key branch. They never push and
never open pull requests — the server does that, on the operator's decision.

The standard workflow is five stages: **Triage → Ready → In Progress → Review → Done**.
A task starts at Triage, where the operator sharpens a rough goal into something a
specialist can actually build against and surfaces whatever it cannot decide alone. Once
the goal and its acceptance criteria hold up, the task moves to Ready — the queue of work
that is genuinely ready to be picked up.

At In Progress a specialist agent takes the task on its branch, makes the smallest correct
change, validates it, and reports back to the operator with what it changed and how it
checked. When the operator judges the work ready, the server pushes the branch and opens
the review pull request; the task enters Review. There a reviewer critiques the change
against the goal's acceptance criteria, and verdicts are bound to the specific revision
they were given — so a later commit does not silently inherit an earlier approval. A
human approving on the PR counts as a verdict too.

Done is the human's call. The move into the terminal stage is always a human decision,
with one disclosed exception: a full-autonomy operator holding an explicit grant may
accept, and even then the merge stays pending for a person.

What makes the movement *governed* rather than merely automated is the boundary on each
transition. Every stage edge is configured as `auto` (the operator may cross it),
`approval` (the operator asks, a human approves) or `human` (a human decides, full stop).
Humans are gated by project roles — admin, maintainer, contributor, viewer — through a
single permission table. Agents are gated separately by capability settings, per action:
`direct`, `recommend`, `human` or `off`. Loosening what agents may do is a deliberate
configuration change, not a side effect of a busy afternoon.

Everything consequential is typed, audited and visible: timeline events, audit records for
governed actions, notifications for the people who actually have to act, and live updates
in the UI. The design principle underneath is honesty over silence — a missing credential
is a typed degraded state rather than a mysterious failure, a failed push surfaces git's
own words, and numbers the product cannot measure are simply not printed.

## Where this goes

The bet Viberr makes is that the interesting constraint on agent-driven engineering is no
longer capability, it is governance: knowing who decided what, on which revision, under
which rule. A task system that treats agents as first-class workers and humans as the
people who set and hold the boundaries is a better fit for that world than one that treats
agents as an assistive feature.

Viberr is pre-production today; formats and schemas still change. But the shape is
settled: one task file as the operating contract, one operator per task, specialists doing
the work behind governed boundaries, and a human at the end saying yes.
