import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import {
  readTaskSources,
  resolveTaskSource,
  writeTaskSource,
  type SourceLook,
  type TaskSource,
} from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readsAsCredential } from "~/server/secrets/git-output-redact.server";
import { PAGE_CAPTURE_VIEWS, pageCaptureView } from "~/shared/page-capture";
import { aboutMs, pictureWebPage, type PageMotion, type WebPagePicture } from "./page-capture.server";
import { idRange, keptLooks } from "./page-looks.server";
import { taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 327: **a task keeps how a page on the web looked.**
 *
 * A result made to look like a page on the web was judged against the address
 * as it read on the day of each review, or against a description somebody
 * wrote of it. The page moves: two reviews saw two pages, and a description
 * is its writer's reading. `keep_page_look` pictures the address once, whole,
 * at the two widths a delivered page is pictured at, with its first screen at
 * three moments while it moves and what the renderer read of its motion, and
 * keeps all of it on the task as sources that share one date. Every later
 * judgement reads those (ruling 329 holds a reviewer's approval to them).
 *
 * One look of an address per task: a second ask for it is answered with the
 * one kept. A task takes over the look another task of the project keeps
 * (`from`), byte for byte and under its date, so the pages of one piece of
 * work are judged against one look and not against one each.
 */

/** The tool's name, on either backend. */
export const KEEP_PAGE_LOOK_NAME = "keep_page_look";

const ADDRESS_MAX_CHARS = 2_000;
const px = (n: number): string => Math.round(n).toLocaleString("en-US");
const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

export interface KeepPageLookInput {
  projectSlug: string;
  taskKey: string;
  /** The address to picture. */
  url?: string | undefined;
  /** Another task of the project whose kept look to take over. */
  from?: string | undefined;
  actorRef: FileActorRef;
  runId: string | null;
}

const refused = (why: string): string => `[noop] ${why} Nothing was kept.`;

/** A host that is this machine or a private network, by its name or its
 *  literal address: a look is of a page on the web. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) {
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

/** The address a look is asked of, or the sentence that says why it is not one. */
function webAddress(raw: string): { address: URL } | { not: string } {
  const typed = raw.trim();
  if (!typed || typed.length > ADDRESS_MAX_CHARS) {
    return { not: `Give \`url\` as one address of at most ${ADDRESS_MAX_CHARS.toLocaleString("en-US")} characters.` };
  }
  let address: URL;
  try {
    address = new URL(typed);
  } catch {
    return { not: "`url` is not an address a browser opens. Give it whole, with `https://`." };
  }
  if (address.protocol !== "http:" && address.protocol !== "https:") {
    return { not: "A look is of a page a browser opens over `http` or `https`." };
  }
  if (address.username || address.password || readsAsCredential(typed)) {
    return { not: "`url` holds what reads as a user name, a token or a password. Give the address without it." };
  }
  if (isLocalHost(address.hostname)) {
    return {
      not: "A look is of a page on the web, and this address is this machine's or a private network's. A page among the task's files is looked at with `capture_page`.",
    };
  }
  address.hash = "";
  return { address };
}

/** What the renderer read of a page's motion, as the lines of the note. */
function motionLines(motion: PageMotion | null): string[] {
  if (!motion) return ["- What moved could not be measured on this page."];
  const lines: string[] = [];
  if (motion.runningCount === 0) {
    lines.push("- Nothing was animating one second after the page loaded.");
  } else {
    const loops = motion.running.filter((entry) => entry.loops);
    const named = motion.running
      .slice(0, 8)
      .map((entry) => `\`${entry.name}\` on \`${entry.target}\`${entry.loops ? " (loops)" : entry.durationMs === null ? "" : ` (${px(entry.durationMs)} ms)`}`);
    lines.push(
      `- ${motion.runningCount === 1 ? "1 animation was" : `${px(motion.runningCount)} animations were`} running one second after the page loaded` +
        (loops.length > 0 ? `, ${loops.length} of them looping without end` : "") +
        `: ${named.join(", ")}${motion.runningCount > named.length ? ", and more" : ""}.`,
    );
  }
  for (const video of motion.videos) {
    lines.push(
      `- A video ${px(video.width)} by ${px(video.height)} px ${video.playing ? "plays" : "does not play"} by itself` +
        `${video.loop ? " and loops" : ""}.`,
    );
  }
  lines.push(
    motion.sticky
      ? `- A bar stays at the top of the screen while the page scrolls (\`${motion.sticky.what}\`, ${motion.sticky.position}).`
      : "- Nothing stays at the top of the screen while the page scrolls.",
  );
  lines.push(
    motion.onScroll === 0
      ? "- Nothing began to animate as it was scrolled into view."
      : `- ${motion.onScroll === 1 ? "1 element" : `${px(motion.onScroll)} elements`} began to animate as ${motion.onScroll === 1 ? "it was" : "they were"} scrolled into view.`,
  );
  if (motion.hover.length === 0) {
    lines.push("- No control among those tried changed its look under the pointer.");
  } else {
    for (const control of motion.hover) {
      lines.push(
        `- Under the pointer, \`${control.what}\` changes its ${LIST_AND.format(control.changes)}` +
          `${control.durationMs === null ? "" : ` over ${px(control.durationMs)} ms`}.`,
      );
    }
  }
  return lines;
}

/** One kept picture of the look, with the record it was kept under. */
interface KeptPicture {
  source: TaskSource;
  picture: WebPagePicture;
}

/** A stretch whose bytes the task already keeps: the page looks the same
 *  there as in the source named, and a task keeps no bytes twice (ruling 82). */
interface RepeatedStretch {
  picture: WebPagePicture;
  same: string;
}

/** What one width's stretches come to, as the note and the answer say it. */
function stretchesSentence(stretches: readonly KeptPicture[], repeats: readonly RepeatedStretch[]): string {
  const last = [...stretches.map((entry) => entry.picture), ...repeats.map((entry) => entry.picture)].reduce((a, b) => (b.to > a.to ? b : a));
  const pictures = stretches.length === 1 ? "1 picture" : `${stretches.length} pictures`;
  const once =
    repeats.length === 0
      ? ""
      : ` ${repeats.length === 1 ? "1 more stretch looks" : `${repeats.length} more stretches look`} the same as one of them and ${repeats.length === 1 ? "is" : "are"} kept once.`;
  return last.cut
    ? `the first ${px(last.to)} px of a page ${px(last.pageHeight)} px long, in ${pictures}. The page runs on below them.${once}`
    : `the whole page (${px(last.pageHeight)} px) in ${pictures}.${once}`;
}

/** The note that closes a look: where its pictures are and what moved. */
function lookNote(
  address: string,
  at: string,
  kept: readonly KeptPicture[],
  repeats: readonly RepeatedStretch[],
  motion: PageMotion | null,
): string {
  const lines = [`# How ${address} looked on ${at.slice(0, 10)}`, "", `Pictured by Viberr at ${at}, at the two widths a delivered page is pictured at.`, ""];
  for (const view of PAGE_CAPTURE_VIEWS) {
    const stretches = kept.filter((entry) => entry.picture.view === view.id && entry.picture.kind === "stretch");
    if (stretches.length === 0) continue;
    const same = repeats.filter((entry) => entry.picture.view === view.id);
    lines.push(`- ${view.label}: ${idRange(stretches.map((entry) => entry.source.id))}, ${stretchesSentence(stretches, same)}`);
    for (const entry of stretches) {
      lines.push(`  - ${entry.source.id}: ${px(entry.picture.from)} to ${px(entry.picture.to)} px.`);
    }
    for (const repeat of same) {
      lines.push(`  - ${px(repeat.picture.from)} to ${px(repeat.picture.to)} px: the same as ${repeat.same}, to the byte.`);
    }
    const frames = kept.filter((entry) => entry.picture.view === view.id && entry.picture.kind === "frame");
    if (frames.length > 0) {
      lines.push(
        `- Its first screen while it loaded: ${idRange(frames.map((entry) => entry.source.id))}, about ` +
          `${LIST_AND.format(frames.map((entry) => `${px(aboutMs(entry.picture.moment ?? 0))} ms`))} after it came into view. ` +
          (frames.length === 1 ? "The moments pictured did not differ, so one is kept." : "What differs between them is what moved."),
      );
    }
  }
  lines.push("", "## What moved, as measured at the desktop width", "", ...motionLines(motion), "");
  lines.push(
    "The pictures show the page at rest and its first screen at a few moments. What a visitor's own pointer or scrolling does beyond the lines above is not in them.",
  );
  return `${lines.join("\n")}\n`;
}

/** The file name a picture of the look is kept under. */
function pictureName(host: string, picture: WebPagePicture, n: number): string {
  const tag = picture.kind === "frame" ? `moving-${n}` : String(n).padStart(2, "0");
  return `${host}-${picture.view}-${tag}.png`;
}

function pictureTitle(host: string, picture: WebPagePicture, n: number, of: number): string {
  const width = pageCaptureView(picture.view).width;
  return picture.kind === "frame"
    ? `${host} at ${width} px: its first screen about ${px(aboutMs(picture.moment ?? 0))} ms after it came into view`
    : `${host} at ${width} px, picture ${n} of ${of}: ${px(picture.from)} to ${px(picture.to)} px of ${px(picture.pageHeight)}`;
}

/** How many of one width's pictures of one kind came before this one, plus one. */
function ordinalAmong(pictures: readonly WebPagePicture[], index: number): number {
  const picture = pictures[index]!;
  return pictures.slice(0, index + 1).filter((other) => other.view === picture.view && other.kind === picture.kind).length;
}

function auditKept(
  db: DatabaseSync,
  input: KeepPageLookInput,
  details: { url: string; at: string; sources: string[]; from: string | null },
): void {
  recordAudit(db, {
    action: "task.page_look.kept",
    actor: { userId: null, label: encodeActorRef(input.actorRef) },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { actorRef: encodeActorRef(input.actorRef), runId: input.runId, ...details, url: details.url.slice(0, 300) },
  });
}

/** How a run reads what a look holds, said at the end of every answer. */
const HOW_TO_READ =
  "Open each picture with `read_task_source`: none is shown here. From now on this look is what the result is made to and judged against: the address will read differently later, and nobody describes it from memory.";

/** Take over the look task `from` keeps: the same bytes, under its date. */
function adoptLook(db: DatabaseSync, ctx: TaskMutationContext, input: KeepPageLookInput, from: string): string {
  const { projectSlug, taskKey, actorRef } = input;
  if (actorRef.kind !== "agent") return refused("A look is kept by an agent's run.");
  if (from === taskKey) return refused(`${taskKey} is this task: \`from\` names another task of the project.`);
  if (!readTaskFile(taskRef(ctx, projectSlug, from))) {
    return refused(`There is no task ${from} in this project; \`read_board\` lists its tasks.`);
  }
  const theirs = readTaskSources(projectSlug, from, ctx.dataRoot).sources.filter((source) => source.look);
  if (theirs.length === 0) return refused(`${from} keeps no look of a page.`);
  const mine = readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources;
  const adopted: string[] = [];
  const looks = new Set<string>();
  for (const source of theirs) {
    const look = source.look!;
    if (mine.some((kept) => kept.look?.url === look.url && kept.look.at !== look.at)) {
      return refused(
        `${taskKey} already keeps a look of ${look.url} from another day, and a result is judged against one look of an address.`,
      );
    }
    const resolved = resolveTaskSource(projectSlug, from, source.id, ctx.dataRoot);
    if (!resolved) continue;
    const written = writeTaskSource(
      projectSlug,
      taskKey,
      {
        name: source.name,
        data: readFileSync(resolved.abs),
        title: source.title,
        from: `${source.from} (kept on ${from} as ${source.id})`.slice(0, 2_000),
        by: { backend: actorRef.backend, profileId: actorRef.profileId, roleHint: actorRef.roleHint },
        runId: input.runId,
        look,
      },
      ctx.dataRoot,
    );
    if ("kept" in written) adopted.push(written.kept.id);
    looks.add(`${look.url} as it was pictured on ${look.at.slice(0, 10)}`);
  }
  if (adopted.length === 0) {
    return `[noop] ${taskKey} already keeps what ${from} keeps of ${LIST_AND.format([...looks])}. \`read_task_source\` lists it.`;
  }
  const first = theirs[0]!.look!;
  auditKept(db, input, { url: first.url, at: first.at, sources: adopted, from });
  return (
    `[kept] ${taskKey} now keeps ${LIST_AND.format([...looks])}, taken over from ${from} byte for byte, as ${idRange(adopted)}. ` +
    HOW_TO_READ
  );
}

/**
 * `keep_page_look`: picture one page on the web and keep the pictures on the
 * run's task, or take over the look another task keeps. The answer is the
 * sentence the run reads.
 */
export async function keepPageLook(db: DatabaseSync, ctx: TaskMutationContext, input: KeepPageLookInput): Promise<string> {
  const { projectSlug, taskKey, actorRef } = input;
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!task) return refused(`There is no task ${taskKey} in this project to keep a look on.`);
  if (task.parsed.frontmatter.archived) return refused(`${taskKey} is archived, so nothing more is kept on it.`);
  if (actorRef.kind !== "agent") return refused("A look is kept by an agent's run.");
  const from = input.from?.trim();
  const typed = input.url?.trim();
  if (from && typed) return refused("Give `url` to picture a page, or `from` to take over the look another task keeps: not both.");
  if (from) {
    try {
      return adoptLook(db, ctx, input, from);
    } catch (error) {
      if (isAppError(error) && error.code === ERROR_CODES.VALIDATION_FAILED) return refused(error.userMessage);
      throw error;
    }
  }
  if (!typed) return refused("Give `url`, the address of the page to picture, or `from`, a task of this project that keeps one.");
  const asked = webAddress(typed);
  if ("not" in asked) return refused(asked.not);
  const url = asked.address.href;
  const host = asked.address.hostname.replace(/^www\./, "");

  const before = readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources;
  const standing = keptLooks(before).find((look) => look.url === url);
  if (standing) {
    return (
      `[noop] ${taskKey} already keeps how ${url} looked on ${standing.at.slice(0, 10)} (${idRange(standing.stretches.map((s) => s.id))}). ` +
      "A result is judged against one look of an address: read that one. `read_task_source` lists every picture of it."
    );
  }

  const answer = await pictureWebPage(db, ctx, { projectSlug, taskKey, url, runId: input.runId });
  if ("busy" in answer) return "[busy] The renderer is working on other pages. Call again in a moment.";
  if ("refused" in answer) {
    return `[error] ${url} could not be pictured: ${answer.refused}. Nothing was kept. Say in your report that the page could not be opened, and state nothing about its look from memory.`;
  }
  const at = new Date().toISOString();
  const by = { backend: actorRef.backend, profileId: actorRef.profileId, roleHint: actorRef.roleHint };
  const kept: KeptPicture[] = [];
  const repeats: RepeatedStretch[] = [];
  try {
    for (const [index, picture] of answer.pictures.entries()) {
      const n = ordinalAmong(answer.pictures, index);
      const of = answer.pictures.filter((other) => other.view === picture.view && other.kind === picture.kind).length;
      const look: SourceLook =
        picture.kind === "frame"
          ? { url, at, part: "frame", view: picture.view, moment: picture.moment ?? 0 }
          : { url, at, part: "stretch", view: picture.view, from: picture.from, to: picture.to, pageHeight: picture.pageHeight };
      const written = writeTaskSource(
        projectSlug,
        taskKey,
        {
          name: pictureName(host, picture, n),
          data: picture.bytes,
          title: pictureTitle(host, picture, n, of),
          from: `${url}, pictured by Viberr at ${pageCaptureView(picture.view).width} px on ${at.slice(0, 10)}`,
          by,
          runId: input.runId,
          look,
        },
        ctx.dataRoot,
      );
      // A frame whose bytes are already kept is a moment at which nothing had
      // moved: the picture it equals stands for both. A stretch whose bytes
      // are is a part of the page that looks the same as another, and is
      // said, so the pictures kept still account for the whole page.
      if ("kept" in written) kept.push({ source: written.kept, picture });
      else if ("already" in written && picture.kind === "stretch") repeats.push({ picture, same: written.already.id });
    }
    const note = writeTaskSource(
      projectSlug,
      taskKey,
      {
        name: `${host}-what-moved.md`,
        data: Buffer.from(lookNote(url, at, kept, repeats, answer.motion)),
        title: `${host}: where its pictures are, and what moved on it`,
        from: `${url}, read by Viberr's renderer on ${at.slice(0, 10)}`,
        by,
        runId: input.runId,
        look: { url, at, part: "note", view: null },
      },
      ctx.dataRoot,
    );
    const ids = kept.map((entry) => entry.source.id);
    const noteId = "kept" in note ? note.kept.id : null;
    auditKept(db, input, { url, at, sources: noteId ? [...ids, noteId] : ids, from: null });
    const parts = [`[kept] How ${url} looked on ${at.slice(0, 10)} is kept on ${taskKey}.`];
    for (const view of PAGE_CAPTURE_VIEWS) {
      const stretches = kept.filter((entry) => entry.picture.view === view.id && entry.picture.kind === "stretch");
      if (stretches.length === 0) continue;
      const same = repeats.filter((entry) => entry.picture.view === view.id);
      parts.push(`${view.label}: ${idRange(stretches.map((entry) => entry.source.id))}, ${stretchesSentence(stretches, same)}`);
    }
    const frames = kept.filter((entry) => entry.picture.kind === "frame");
    if (frames.length > 0) parts.push(`Its first screen while it loaded: ${idRange(frames.map((entry) => entry.source.id))}.`);
    if (noteId) parts.push(`Where each picture is and what moved on the page, as measured: ${noteId}.`);
    parts.push(HOW_TO_READ);
    return parts.join(" ");
  } catch (error) {
    // The task keeps as much as it may: the store's own sentence, and what
    // was kept before it stands and is named.
    if (isAppError(error) && error.code === ERROR_CODES.VALIDATION_FAILED) {
      const ids = kept.map((entry) => entry.source.id);
      return (
        `[error] ${error.userMessage} ` +
        (ids.length > 0 ? `Kept before that: ${idRange(ids)}, which is part of the look and not all of it.` : "Nothing was kept.")
      );
    }
    throw error;
  }
}
