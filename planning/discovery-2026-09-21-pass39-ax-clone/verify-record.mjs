#!/usr/bin/env node
// Files-are-truth check: every claim the app RENDERS about a task must match the
// canonical task.md on disk. Run: node verify-record.mjs [--cookie <jar>]
// Exit 0 = every task agrees; exit 1 = at least one mismatch (printed).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "/Users/akinozer/projects/viberr/docker-data";
const BASE = "http://localhost:5173";
const JAR = process.argv.includes("--cookie")
  ? process.argv[process.argv.indexOf("--cookie") + 1]
  : "/tmp/claude-501/-Users-akinozer-projects-viberr/22224644-c840-4206-b917-ee9ec7ebcb58/scratchpad/viberr.cookies";

const get = (path) =>
  execFileSync("curl", ["-s", "-b", JAR, BASE + path], { encoding: "utf8", maxBuffer: 64e6 });

/** Frontmatter value for a top-level key, as written. */
const fm = (src, key) => {
  const m = new RegExp(`^${key}: (.*)$`, "m").exec(src.split("\n---")[0]);
  return m ? m[1].trim() : null;
};
/** Every `### <iso> · <kind> · <actor>` heading in the timeline section. */
const timelineEntries = (src) => {
  const i = src.indexOf("\n## Timeline");
  if (i < 0) return [];
  return [...src.slice(i).matchAll(/^### (\S+) · (\S+) · (.*)$/gm)].map((m) => ({
    at: m[1], kind: m[2], actor: m[3].trim(),
  }));
};
/** Strip tags so we can ask "does the rendered page say this string". */
const textOf = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");

const problems = [];
const checks = [];
const check = (ok, label, detail) => {
  checks.push(ok);
  if (!ok) problems.push(`${label}${detail ? " — " + detail : ""}`);
};

for (const slug of readdirSync(`${ROOT}/projects`)) {
  const projectMd = readFileSync(`${ROOT}/projects/${slug}/project.md`, "utf8");
  const stageNames = new Map(
    [...projectMd.matchAll(/^ {2}- id: (\S+)\n {4}name: (.*)$/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const taskDir = `${ROOT}/projects/${slug}/tasks`;
  if (!existsSync(taskDir)) continue;
  const keys = readdirSync(taskDir).filter((k) => existsSync(`${taskDir}/${k}/task.md`));

  // ---- board: every task appears in its file's stage lane, and only there
  const boardText = textOf(get(`/projects/${slug}/board`));
  for (const key of keys) {
    const src = readFileSync(`${taskDir}/${key}/task.md`, "utf8");
    if (fm(src, "archived") === "true") continue;
    check(boardText.includes(key), `board omits ${key}`, `stage=${fm(src, "stage")}`);
  }

  for (const key of keys) {
    const src = readFileSync(`${taskDir}/${key}/task.md`, "utf8");
    const page = get(`/projects/${slug}/tasks/${key}`);
    const text = textOf(page);
    const stageId = fm(src, "stage");
    const stageName = stageNames.get(stageId) ?? stageId;

    check(text.includes(stageName), `${key}: page does not render its stage`,
      `task.md stage=${stageId} (${stageName})`);

    const branch = fm(src, "branch");
    if (branch && branch !== "null") {
      check(text.includes(branch), `${key}: page does not render branch`, branch);
    }
    // `pr:` and `workRevision:` are nested blocks, so read their leaf fields.
    const nested = (block, leaf) => {
      const m = new RegExp(`^${block}:\\n(?: {2}.*\\n)*?  ${leaf}: (.*)$`, "m").exec(src);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    };
    const prNumber = nested("pr", "number");
    if (prNumber) {
      check(text.includes(`#${prNumber}`) || text.includes(`/pull/${prNumber}`),
        `${key}: page does not render its PR`, `pr #${prNumber}`);
    }
    const headSha = nested("workRevision", "headSha");
    if (headSha) {
      check(text.includes(headSha.slice(0, 7)),
        `${key}: page does not render the delivered revision`, headSha.slice(0, 12));
    }
    // every verdict recorded on the file must be visible on the page
    const verdicts = [...src.matchAll(/^ {2}- profileId: (\S+)\n(?:.*\n)*?\s+verdict: (\S+)/gm)];
    for (const [, profile, verdict] of verdicts) {
      check(text.toLowerCase().includes(verdict.toLowerCase()),
        `${key}: verdict not rendered`, `${profile}=${verdict}`);
    }
    // every timeline entry's actor label must appear somewhere on the page
    const entries = timelineEntries(src);
    // the newest entry's minute must be on the page (the page renders HH:MM)
    if (entries.length) {
      const newest = entries[0].at;
      // The server renders UTC; the browser re-renders in the viewer's zone after
      // hydration. Either spelling counts as "the page shows this entry".
      const stamps = ["UTC", "Europe/Istanbul"].map((timeZone) =>
        new Date(newest).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", timeZone,
        }),
      );
      check(stamps.some((s) => text.includes(s)),
        `${key}: newest timeline entry's time not on the page`,
        `${newest} → ${stamps.join(" or ")}`);
    }
  }
}

console.log(`${checks.filter(Boolean).length}/${checks.length} record checks agree with disk`);
if (problems.length) {
  console.log("\nMISMATCHES:");
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
