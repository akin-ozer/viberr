# Goal 1 — given to the instance controller (new conversation), 2026-09-18

Build a production-grade Airbnb clone in the GitHub repo akin-ozer/airbnb-clone. The repo exists and is currently EMPTY — no commits, no default branch. You own this end to end: set yourself up, then drive it through Viberr's own machinery. I am watching, not helping.

THE PRODUCT
- A two-sided marketplace for short-term stays. Guests: search stays by place, dates and guest count; filter by price, type and amenities; open a listing (photos, description, amenities, an availability calendar, the nightly price with a full price breakdown, a host card, reviews); book it (dates, guest count, total, a reservation with a real state machine — requested / confirmed / cancelled / completed — and a payment step behind a real, swappable payment adapter); see and cancel their trips; save listings to wishlists; message the host; review the stay after it completes.
- Hosts: become a host, create and edit listings (photos, amenities, house rules, pricing, availability and blocked dates), see a calendar of reservations, accept or decline booking requests, message guests, review guests after a stay.
- Identity with guest and host roles. Availability must be correct under concurrent bookings: two guests can never hold the same nights. Reviews are two-sided and only after a completed stay.
- Real schemas, real persistence, real HTTP between services if you split them, per-service tests, one command brings the whole thing up. Not a toy.
- The service split, the stack, the schemas, the screens and the tests are YOUR call, not mine. If you split into services, say how the boundaries keep agents from colliding.

THIS HOST (measured; it is in your instance_health): node 26, npm, pnpm, git, make, curl. NO docker, NO python, NO go, NO browser in any gate. Choose a stack that runs cold from a clean checkout on exactly that.

HOW I WANT YOU TO WORK
- Create the project yourself: workflow stages and boundaries that suit this work, the repo attach, the policy. Don't ask me to pre-build any of it.
- Create the agent profiles the work needs (backend, frontend, infra, reviewer, whatever) with the capability grants each one actually needs, plus knowledge bases and skills, and MCP servers if they help. Every task's text names the path set it owns.
- MODEL POLICY, strict: the Codex backend is out of quota until the morning of Sep 19 and must not be used by anything. Every agent you create or deploy — the operator, every reviewer, every delivery specialist — runs on the Claude backend, model `opus`, effort `high`. You stay on Opus. If a surface won't let you set that, say so plainly instead of working around it.
- 25+ tasks, sequenced. Several agents in one repo at once: sequence that deliberately and tell me how you're keeping them from colliding.
- Use goals and chained goals to carry the work forward, not one-shot task creation.
- Required reviewers on the review stage, with real verdicts. Every pull request is merged by ME, never by an agent, and I will reject some.

Start by telling me your setup plan — stages, agent profiles, the task breakdown — then execute it. Don't wait for me between steps; I'll interrupt if I disagree.
