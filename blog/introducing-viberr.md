# Introducing Viberr: Governed AI Delivery for Small Engineering Teams

Your coding agents are getting smarter. But your task system hasn't changed in a decade. Jira and GitHub issues were built for humans to hand off work to each other. They're clunky when the workers are persistent AI agents that need to coordinate across multiple tasks, stay anchored to a single source of truth, and let humans keep control of approval and flow.

That's the gap Viberr fills. We built it for small AI-forward teams that want their agents to own real delivery work while engineers retain governance. The result is a different kind of task system: agents are the native workers, humans govern the flow, and every task carries its own durable operating contract.

## What is Viberr?

Viberr is a multi-user web application for governed AI software delivery. It's designed around a simple insight: persistent coding agents need a coordination layer that matches how they work, not how humans have always worked.

Unlike Jira or Linear, where humans are the default workers and AI helps at the edges, Viberr flips the model. Agents execute the stage work. A dedicated operator agent coordinates each task. Humans govern through policy, comments, decisions, and explicit acceptance. The task itself, written in Markdown, becomes the canonical contract between humans, agents, and GitHub.

The key difference is durability. Agent chats scatter context across sessions, branches, and messages. Viberr anchors everything to a single readable task file. That file holds the goal, current stage, assignments, execution context, timeline, decisions, and evidence in one place. Agents can be paused and resumed without losing continuity. Humans can understand the full state of multi-agent work without rebuilding context from a dozen tools.

## How the Workflow Operates

Viberr enforces a staged workflow designed for agent-native delivery. Here's how it works.

**The five stages** mirror a typical software task:

- **Triage**: The operator evaluates whether the goal is clear and ready for execution, or flags underspecified tasks for human clarification.
- **Ready**: Once scoped, the task waits for a primary specialist agent to be assigned.
- **In Progress**: The specialist executes the work, creating a task-key branch in GitHub and pushing commits tied back to the task.
- **Review**: The operator transitions the task here, attaching validation evidence. A reviewer agent (or human) evaluates the work.
- **Done**: Only humans can move a task to done, after accepting the completion report.

**The agent model** separates coordination from execution. The operator agent owns task flow: it recommends assignments, flags blockers, and transitions tasks between stages. Specialist agents (Developer, Reviewer) do the actual work: implementing features, running tests, providing code review. If a task gets blocked, the system surfaces a structured decision packet rather than vague chatter.

**Capability policy** gives teams fine-grained control. You define which agent actions are:

- **Direct**: The agent can do it without asking.
- **Recommend**: The agent suggests the action; a human approves.
- **Human**: Only humans can act here.
- **Off**: Disabled entirely.

For example, you might let the developer agent commit directly, but require human approval before merging to main. The reviewer agent might only report findings; humans make the accept/reject decision. This separation of agent capability from human authority is why Viberr can safely give agents real ownership of execution.

## A Task in Motion

Here's a concrete example: implementing a new feature for a billing service.

An engineer creates the task VIB-153 with a clear goal: "Add retry logic to the payment processor." The operator evaluates it in Triage, confirms it's scoped, and transitions it to Ready.

In Ready, an engineer assigns the Developer specialist (running on Codex) and sets a policy that GitHub branches can be created automatically but PRs need human review. The operator transitions to In Progress and engages the developer.

The developer creates branch `vib-153-payment-retry`, writes code and tests, and pushes commits tied to the task. As it works, Viberr records each meaningful event in the task timeline: assignments, quality flags, policy checks, and evidence links. Once implementation is done, the developer signals completion, and the operator transitions to Review.

In Review, the Reviewer agent (Claude Code) examines the code and results. Meanwhile, a human engineer takes ownership of the task as the acceptance authority. The reviewer reports findings; if validation is green, the operator generates a completion report. The human owner reviews it, approves, and marks the task done. Viberr auto-merges the PR.

Throughout this flow, a single Markdown file in your Git repo holds the truth. Every event is recorded. GitHub branch and PR state is reflected back into the task. If an agent connection drops, it resumes from the task file, not from lost chat history.

## Why It Matters

Teams working with coding agents today face a coordination crisis. Your agents are scattered across tool windows: Claude in the web UI, Codex in the IDE, each session isolated. When multiple agents or humans touch the same task, state gets confused. Reviews get lost. Approval boundaries blur.

Viberr makes agent-driven delivery something humans can supervise and trust. You don't need to understand every agent interaction; you just need to see the current state, blockers, and completion status. Engineers keep authority over the parts that matter: approval, flow, and acceptance. Agents own the execution.

## Getting Started

Viberr is open source and designed for small teams. Set it up locally, connect your GitHub repo, configure your workflow stages and agent policy, and start running real tasks.

The strongest teams are already using coding agents ad hoc. Viberr turns that into a durable operating model. Ready to centralize your agent-driven delivery? Start with a single project and a few tasks.

Learn more at the [Viberr repository](https://github.com/akin-ozer/viberr).
