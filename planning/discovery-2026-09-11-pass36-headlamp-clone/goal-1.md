Set this instance up to build a real product, then run the build through viberr's own machinery. I will merge, accept and move tasks into Done myself; everything else is yours and the operator's.

THE PRODUCT. A clone of Headlamp (https://headlamp.dev), a web UI for Kubernetes, in the empty repository akin-ozer/headlamp-clone (the akin-ozer GitHub connection is stored on this instance; attach it, default branch main). What the product is exactly, the stack, the schema, the screens, the tests and the tooling are your call, not mine, with two constraints: (1) it must be something I can actually run against a cluster with my kubeconfig, not a toy: cluster connection, resource lists (pods, deployments, services, nodes at least), detail views with container logs and events, namespace switching, a YAML view, and search; (2) it must build and test inside viberr's own runtime image, so check what that runtime can actually run before you pick a stack, and pick one it can build, test and lint without installing a toolchain per run.

MODELS. Every agent you deploy on the project, the operator, every reviewer and every delivery specialist, runs on Codex model gpt-5.6-luna at effort max. No exceptions, and read back what you wrote to confirm it. (I run you on Claude Opus high; that is set already.)

SET UP EVERYTHING YOURSELF, and tell me plainly anything you could not create or could only create half-way:
- the project, with custom workflow stages that fit this build (not the stock ones) and explicit transition boundaries: at least one boundary that a human must approve before a PR can be merged, and Done stays a human move;
- required reviewers whose verdicts are bound to the revision they reviewed, so a PR that changes after a review has to be re-reviewed;
- agent profiles: rewrite or create the templates this product needs (a delivery specialist or two, a dedicated reviewer, whatever else you judge useful), deploy them to the project with the exact capability grants each one needs and nothing more; give at least one delivery agent the browser capability and the ability to post attachments, because I want a screenshot of the running UI on the task thread at some point;
- knowledge bases and skills with the product spec, the engineering standards and the review checklist you decide on, granted to the agents that need them;
- any MCP server you judge useful (register it and test it; if it needs a secret I will add it in Org settings when you tell me);
- schedules where they make sense (for example a periodic operator check on a long-running task);
- chained goals that decompose the whole product into an ordered sequence of tasks, each task one branch-plus-PR cycle sized for one delivery run. I expect 25 or more tasks in total across the chains and at least 8 of them to reach a merged PR today; sequence them so the foundation lands first and later chains wait on it.

GOVERNANCE. Operator autonomy supervised. The operator triages, picks agents and moves tasks; it never crosses the human approval boundary alone. Reviewers give verdicts; a request-changes verdict sends the work back. If something goes wrong, open a decision packet for me rather than guessing.

When the setup is done, start the first task and report back: the project, its stages and boundaries, every agent with its backend/model/effort, the resources you created, the goal chains with their link counts, and every refusal, deviation or thing you could not do, in your own words.
