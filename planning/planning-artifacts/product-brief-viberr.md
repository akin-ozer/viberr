---
title: "Product Brief: viberr"
status: "complete"
created: "2026-03-29T21:09:12Z"
updated: "2026-03-29T21:14:48Z"
inputs:
  - "/Users/akinozer/projects/viberr/_bmad-output/brainstorming/brainstorming-session-2026-03-29-12-02-32.md"
---

# Product Brief: Viberr

## Executive Summary

Software teams are starting to use coding agents seriously, but the operating model around them is still human-native. Planning lives in Jira or Linear, code lives in GitHub, and agent execution lives in disconnected CLI sessions, logs, and chat histories. The result is a broken control loop: tasks do not reliably capture what the agent understood, what changed in code, what is blocked, what decision is needed, or whether the work is actually safe to advance.

Viberr is a governed AI delivery tool for software teams that want agents to do meaningful work without losing control of quality, review, or execution clarity. It gives every task a canonical operating contract, every active task a dedicated operator agent, and every execution stage a governed specialist workflow backed by real Codex or Claude Code runs. Humans stop acting like workflow clerks and start acting like governors: they configure projects, review decision packets, intervene when quality or ambiguity demands it, and explicitly accept completion. Viberr’s advantage is not generic AI assistance. Its advantage is turning delivery itself into a durable governed system where agents, humans, and GitHub execution stay aligned. The initial wedge is small AI-forward engineering teams already using CLI coding agents and GitHub, but lacking a reliable operating model to govern them.

## The Problem

Current task systems assume humans are the native workers. They are good at assigning tickets, tracking status, and visualizing flow, but they are weak at governing autonomous or semi-autonomous software agents. Teams experimenting with AI delivery quickly run into the same failure modes:

- The task tracker does not reflect what the agent is actually doing.
- Agent context and reasoning live in private threads that the team cannot govern or inspect.
- Code changes, validation results, branches, and pull requests are weakly linked back to task intent.
- Human intervention happens through side channels, so the operational record drifts from reality.
- AI activity becomes noisy rather than trustworthy because the system rewards commentary more than delivery.

The cost is not just inconvenience. It is loss of confidence. If teams cannot see why an agent is blocked, what changed, what risk exists, and what decision is needed, they fall back to manual coordination and the promise of agent-enabled throughput disappears.

## The Solution

Viberr manages Jira-like projects in its own local, file-native management plane while attaching tasks to GitHub repositories for execution. Each task is stored as a canonical markdown file in a stable task directory such as `tasks/VIB-142/task.md`. That file is the authoritative operating contract for the task: identity, goal, current state, execution context, conversation timeline, typed important events, related files and commits, subtasks, and human decisions all live in one readable artifact.

Each task gets a dedicated operator agent thread with persistent memory. The operator monitors the task, validates quality, recommends assignment, decides when specialists should be engaged, prepares human decision packets, and opens the PR when the task reaches review. Specialist agents also have persistent threads, but only one is the primary owner at a time; others remain available as consultants. Agents append meaningful comments and event requests directly to the task timeline, but official state changes remain human-authorized. When implementation begins, the task attaches to a single GitHub repository, receives a fresh execution workspace, and works on a branch named after the task key. Review is backed by a live GitHub PR, and moving a task to `done` always requires explicit human acceptance.

## What Makes This Different

**Agent-native by design.** Viberr is not a standard board with AI layered on top. Agents are the native workers, and the workflow is built around their needs, constraints, and handoffs.

**Canonical task contract.** The task is not a ticket pointing somewhere else. It is the durable operating record shared by humans, the operator agent, specialist agents, and GitHub execution.

**Persistent operator model.** Each task has a long-lived coordinating intelligence that keeps continuity over the lifecycle, rather than relying on stateless automation or generic workflow rules alone.

**GitHub-native execution.** Branches, commits, sync behavior, PR-backed review, and repository permissions are part of the core product, not a loose integration bolted on after the fact.

**Anti-bureaucracy guardrails.** Viberr is explicitly designed to avoid AI process theater. Agents comment only at meaningful boundaries, operator comments must stay concise, duplicate summaries are avoided, old context is compressed, and raw evidence is kept separate from the main task narrative.

## Who This Serves

**Primary users:** small AI-forward engineering teams that already trust coding agents enough to let them perform meaningful implementation work, but do not yet have a reliable operating model for governing that work.

These are typically:

- engineering teams already experimenting with Codex or Claude Code in real delivery work
- tech leads who need an inspectable system for coordinating multiple specialist agent runs
- small product teams that want agent throughput without surrendering review and acceptance control

The best first adopters are likely small AI-forward engineering teams already comfortable with GitHub-centric workflows and local CLI agent tooling. They have the motivation to govern agents seriously, but still have enough workflow flexibility to adopt a new operating model quickly.

**Secondary users:** solo or small-team builders who want a durable, file-native control plane for Codex- or Claude-driven development without adopting heavyweight enterprise process tools.

## Success Criteria

Viberr is working if it creates more trust and throughput than today’s human-native alternatives. Early success should be measured through:

- a high percentage of active tasks with an unambiguous current owner, waiting state, and latest decision packet
- strong traceability between task, branch, commits, and pull request for most executed work
- reduced time from implementation start to review-ready PR on agent-executed tasks
- low time-to-decision for blocked tasks because intervention packets are concise and actionable
- sustained task readability over long-running work, with minimal complaints about timeline noise or context loss

## Scope

### In Scope for V1

- local filesystem management store with explicit project, task, runtime, cache, auth, and log domains
- canonical markdown task files in per-task directories
- rule-driven workflow definition with stage rules, transition constraints, and assignment boundaries
- separate human RBAC and project-scoped agent capability policy
- task-dedicated persistent operator agent thread
- one primary specialist owner plus persistent consultant specialists
- Codex or Claude Code backed non-interactive runs with separate runtime histories
- GitHub authentication and single-repo task attachment
- task-key branch naming, bracketed task-key commits, and PR-backed review
- board cards optimized for triage and task pages optimized for operator-style review
- multi-user collaboration for small teams
- typed important events only for quality flags, transition requests, blocked decisions, completion reports, subtask spawning, and policy violations

### Explicitly Out of Scope for V1

- multi-repo tasks
- non-GitHub VCS support
- automatic transition to `done`
- forcing success criteria or test evidence at task creation for every task
- typing every interaction in the system
- broad enterprise multi-tenant SaaS concerns beyond the initial small-team wedge

## Technical Approach

Viberr should stay local-first and file-native in its management plane, with hybrid file watchers plus manual re-scan for resilience. It should treat provider runtime history as valuable but non-authoritative: any reactivated agent must re-anchor on the current canonical task file before acting, and if runtime history is missing, the system must degrade gracefully from the task artifact and current execution context.

On the GitHub side, Viberr should sync task branches at meaningful stage boundaries, surface branch health clearly, and convert sync or rebase failures into explicit blocking signals. The product will succeed or fail on whether it can keep workflow truth and repository reality aligned without becoming noisy or bureaucratic.

## Vision

If Viberr succeeds, task management stops being a human-only planning surface and becomes the governed delivery layer for software teams working with agents. A task becomes a durable machine-readable contract, the operator agent becomes a trusted coordinator, specialist threads become reusable expert memory, and GitHub becomes the execution surface beneath a governed AI delivery workflow.

Over time, Viberr can expand from a strong single-user or small-team GitHub-native system into a broader control plane for AI-mediated engineering organizations: richer reusable agent profiles, deeper governance policies, stronger planning-to-execution connections, and eventually full lifecycle orchestration from brief to PR. The long-term opportunity is not just better ticket management. It is a new default operating model for how teams ship software with agents.
