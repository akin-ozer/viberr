import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { writeProject } from "./test-store";

/**
 * One board's `project.md` whose Scout holds `resources`, beside an Operator
 * holding its own skill: the fixture of every suite that asks which boards
 * are given a knowledge base, a skill or an MCP server. `more` is frontmatter
 * the board carries beside the two deployments (its `rulingsKb`, or other
 * `agents`).
 */
export function writeBoardHolding(
  dataRoot: string,
  slug: string,
  resources: { skills?: string[]; mcps?: string[]; kb?: string[] },
  more: Partial<ProjectFrontmatter> = {},
): void {
  writeProject(dataRoot, {
    name: "Viberr Core",
    slug,
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    taskPrefix: "VIB",
    nextTaskNumber: 100,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: [],
    agents: [
      {
        profileId: "operator",
        capabilities: [],
        extras: [],
        definition: { name: "Operator", resources: { skills: ["viberr-app-expertise"] } },
      },
      {
        profileId: "scout",
        capabilities: [],
        extras: [],
        definition: { name: "Scout", resources },
      },
    ],
    credentialPolicy: null,
    guardrails: [],
    requiredReviewers: [],
    fileLeases: [],
    ...more,
  });
}
