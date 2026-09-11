Change of plan for one agent, and a steer for the operators.

Switch the Code Reviewer deployment on headlamp-clone to Claude, model opus, effort high, and keep the operator, the Server Developer and the Frontend Developer on Codex gpt-5.6-luna at max. Reason, for your record: the Codex sandbox on this deployment cannot survive concurrent runs (a viberr defect I am recording), so every reviewer run so far reported request-changes for "missing evidence" without having read anything. Read the deployment back to me after the change.

Then, on every task whose review failed that way (HLC-1, HLC-6, HLC-7 and HLC-8), make sure the operator re-runs the Code Reviewer on the current PR head instead of sending the developer back again: the developers have already confirmed there is nothing to change. Use the steer you judge best (an operator run with a directive, or a comment), and tell me what you did per task.
