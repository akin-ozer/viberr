import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  sourcesRoomRefusal,
  writeTaskSource,
  type LookPicture,
  type TaskSource,
} from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readsAsCredential } from "~/server/secrets/git-output-redact.server";
import { PAGE_CAPTURE_VIEWS, pageCaptureView } from "~/shared/page-capture";
import { aboutMs, pictureWebPage, type PageMotion, type ScrollsInside, type WebPagePicture } from "./page-capture.server";
import { idRange, keptLooks, type KeptLook } from "./page-looks.server";
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
 * keeps all of it on the task as the sources of one look. Every later
 * judgement reads those (ruling 329 holds a reviewer's approval to them).
 *
 * One look of an address per task: a second ask for it is answered with the
 * one kept. A task takes over the look another task of the project keeps
 * (`from`), byte for byte and under its date, so the pages of one piece of
 * work are judged against one look and not against one each.
 *
 * A look is its note (`SourceLook`): written last, it lists every picture the
 * look is made of, by the source each is kept under. Pictures a keep that
 * failed part way left behind are sources of no look, and the next keep of
 * the address takes them up by their bytes and closes with its own note.
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

/**
 * A host that is this machine or a private network, by its name or its
 * literal address: a look is of a page on the web. A name with no dot in it
 * is one only this network answers to (`localhost`, a compose service, a
 * metadata host). What a public name resolves to is not looked up, so a name
 * a person points at a private address still reads as the web: the run's own
 * browser reaches the same places (ruling 193), and this door adds none.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
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

/**
 * One width's stretches among a look's pictures: each source once, and the
 * stretches that look the same, to the byte, as one before them (a task
 * keeps no bytes twice, ruling 82, so they are kept once and said).
 */
function stretchesAt(pictures: readonly LookPicture[], view: LookPicture["view"]) {
  const seen = new Set<string>();
  const kept: LookPicture[] = [];
  const repeats: LookPicture[] = [];
  for (const picture of pictures) {
    if (picture.part === "stretch" && picture.view === view) (seen.has(picture.id) ? repeats : kept).push(picture);
    seen.add(picture.id);
  }
  return { kept, repeats };
}

/** What one width's stretches come to, as the note and the answer say it. */
function stretchesSentence(kept: readonly LookPicture[], repeats: readonly LookPicture[]): string {
  const last = [...kept, ...repeats].reduce((a, b) => ((b.to ?? 0) > (a.to ?? 0) ? b : a));
  const pictures = kept.length === 1 ? "1 picture" : `${kept.length} pictures`;
  const once =
    repeats.length === 0
      ? ""
      : ` ${repeats.length === 1 ? "1 more stretch looks" : `${repeats.length} more stretches look`} the same as one of them and ${repeats.length === 1 ? "is" : "are"} kept once.`;
  return last.cut
    ? `the first ${px(last.to ?? 0)} px of a page ${px(last.pageHeight ?? 0)} px long, in ${pictures}. The page runs on below them.${once}`
    : `the whole page (${px(last.pageHeight ?? 0)} px) in ${pictures}.${once}`;
}

/** Where a look's note stops listing its pictures and starts on what moved. */
const WHAT_MOVED_HEADING = "## What moved, as measured at the desktop width";

/**
 * The second half of a look's note: what the renderer read of the page's
 * motion. It holds the page's own names and no id of a source, so a task
 * that takes the look over keeps it word for word.
 */
function whatMoved(motion: PageMotion | null, scrollsInside: readonly ScrollsInside[]): string {
  const lines = [WHAT_MOVED_HEADING, "", ...motionLines(motion), ""];
  if (scrollsInside.length > 0) lines.push(...insideSentences(scrollsInside), "");
  lines.push(
    "The pictures show the page at rest and its first screen at a few moments. What a visitor's own pointer or scrolling does beyond the lines above is not in them.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The note that closes a look: where its pictures are, written from the list
 * the look's record keeps (so a task that takes the look over writes it again
 * with its own ids, and no id is ever changed inside a sentence), then what
 * moved.
 */
function lookNote(address: string, at: string, pictures: readonly LookPicture[], moved: string): string {
  const lines = [`# How ${address} looked on ${at.slice(0, 10)}`, "", `Pictured by Viberr at ${at}, at the two widths a delivered page is pictured at.`, ""];
  for (const view of PAGE_CAPTURE_VIEWS) {
    const { kept, repeats } = stretchesAt(pictures, view.id);
    if (kept.length === 0) continue;
    lines.push(`- ${view.label}: ${idRange(kept.map((picture) => picture.id))}, ${stretchesSentence(kept, repeats)}`);
    for (const picture of kept) lines.push(`  - ${picture.id}: ${px(picture.from ?? 0)} to ${px(picture.to ?? 0)} px.`);
    for (const repeat of repeats) {
      lines.push(`  - ${px(repeat.from ?? 0)} to ${px(repeat.to ?? 0)} px: the same as ${repeat.id}, to the byte.`);
    }
    const frames = pictures.filter((picture) => picture.part === "frame" && picture.view === view.id);
    if (frames.length > 0) {
      lines.push(
        `- Its first screen while it loaded: ${idRange(frames.map((picture) => picture.id))}, about ` +
          `${LIST_AND.format(frames.map((picture) => `${px(aboutMs(picture.moment ?? 0))} ms`))} after it came into view. ` +
          (frames.length === 1 ? "The moments pictured did not differ, so one is kept." : "What differs between them is what moved."),
      );
    }
  }
  return `${lines.join("\n")}\n\n${moved}`;
}

/** Said of a look where parts of the page scroll inside it, a sentence a
 *  width: how many hold more than a screen beyond their box, how much the
 *  one that hides the most holds and in how tall a box, as the page lays
 *  them out, and that the pictures at that width hold none of what they
 *  hide. */
function insideSentences(inside: readonly ScrollsInside[]): string[] {
  return inside.map((entry) => {
    const at = `At ${pageCaptureView(entry.view).width} px`;
    const holds = `holds ${px(entry.height)} px in a box ${px(entry.box)} px tall`;
    return entry.count === 1
      ? `${at} \`${entry.what}\` scrolls inside the page: it ${holds} (sizes as laid out), and what it hides is in no picture at that width.`
      : `${at} ${entry.count} parts of the page that scroll inside it each hold more than a screen beyond their box (sizes as laid out): the one that hides the most, \`${entry.what}\`, ${holds}. What they hide is in no picture at that width.`;
  });
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

/** Said when a look was asked for well and still could not be kept: the task
 *  holds none, and a run that goes on must not describe one. */
const NOT_FROM_MEMORY = "Say in your report that the look could not be kept, and state nothing about it from memory.";

/** The source among a task's whose bytes are one of `hashes` and were taken
 *  out of its store by a person: its record stands and its file is gone. */
function removedAmong(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  held: readonly TaskSource[],
  hashes: ReadonlySet<string>,
): TaskSource | undefined {
  return held.find((source) => {
    if (!hashes.has(source.sha256)) return false;
    const resolved = resolveTaskSource(projectSlug, taskKey, source.id, ctx.dataRoot);
    return !resolved || !existsSync(resolved.abs);
  });
}

/** How a run reads what a look holds, said at the end of every answer. */
const HOW_TO_READ =
  "Open each picture with `read_task_source`: none is shown here. From now on this look is what the result is made to and judged against: the address will read differently later, and nobody describes it from memory.";

/** "S1 to S9": the sources a look's pictures are kept under, each once. */
const pictureIds = (pictures: readonly LookPicture[]): string[] => [...new Set(pictures.map((picture) => picture.id))];

/**
 * Take over the looks task `from` keeps: the pictures byte for byte, under
 * their date, and each look's note written again with this task's own ids.
 * Checked whole before anything is copied (every picture in the other task's
 * store, none of them taken out of this one's, room for all of it here), and
 * a look counts only once its note is written, so one that could not be
 * finished leaves pictures and no look. A
 * take-over that was cut off is finished by asking again, since a picture
 * already here is taken up by its bytes and the note closes the look.
 */
function adoptLook(db: DatabaseSync, ctx: TaskMutationContext, input: KeepPageLookInput, from: string): string {
  const { projectSlug, taskKey, actorRef } = input;
  if (actorRef.kind !== "agent") return refused("A look is kept by an agent's run.");
  if (from === taskKey) return refused(`${taskKey} is this task: \`from\` names another task of the project.`);
  if (!readTaskFile(taskRef(ctx, projectSlug, from))) {
    return refused(`There is no task ${from} in this project; \`read_board\` lists its tasks.`);
  }
  const theirSources = readTaskSources(projectSlug, from, ctx.dataRoot).sources;
  const theirs = keptLooks(theirSources);
  if (theirs.length === 0) return refused(`${from} keeps no look of a page.`);
  const mine = readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources;
  const standing = keptLooks(mine);
  const clash = theirs.find((look) => standing.some((kept) => kept.url === look.url && kept.at !== look.at));
  if (clash) {
    return refused(
      `${taskKey} already keeps a look of ${clash.url} pictured at another time, and a result is judged against one look of an address.`,
    );
  }
  const named = (look: KeptLook): string => `${look.url} as it was pictured on ${look.at.slice(0, 10)}`;
  const toAdopt = theirs.filter((look) => !standing.some((kept) => kept.url === look.url));
  if (toAdopt.length === 0) {
    return `[noop] ${taskKey} already keeps what ${from} keeps of ${LIST_AND.format(theirs.map(named))}. \`read_task_source\` lists it.`;
  }
  // Read first, so what is missing or does not fit is said before a picture
  // is written: a look arrives whole.
  const record = new Map(theirSources.map((source) => [source.id, source]));
  const bytes = new Map<string, Buffer>();
  for (const look of toAdopt) {
    for (const id of [...pictureIds(look.pictures), look.note]) {
      if (bytes.has(id)) continue;
      const resolved = resolveTaskSource(projectSlug, from, id, ctx.dataRoot);
      if (!resolved || !existsSync(resolved.abs)) {
        return `${refused(`${from} no longer holds ${id} of its look (it was taken out of the store), so the look is not whole.`)} ${NOT_FROM_MEMORY}`;
      }
      bytes.set(id, readFileSync(resolved.abs));
    }
  }
  // Counted as it will be written: a picture this task already keeps, by its
  // bytes, is kept once, and each note is written new.
  const held = new Set(mine.map((kept) => kept.sha256));
  const pictures = pictureIds(toAdopt.flatMap((look) => look.pictures));
  // A picture whose bytes a person took out of this task's store is never
  // kept again (ruling 82), so the look cannot arrive whole: said before
  // anything is copied.
  const gone = removedAmong(ctx, projectSlug, taskKey, mine, new Set(pictures.map((id) => record.get(id)?.sha256 ?? "")));
  if (gone) {
    return `${refused(`A person took ${gone.id} out of ${taskKey}'s store, and it is a picture of this look: the same bytes are not kept again, so the look cannot be taken over whole.`)} ${NOT_FROM_MEMORY}`;
  }
  const fresh = pictures.filter((id) => !held.has(record.get(id)?.sha256 ?? ""));
  const room = sourcesRoomRefusal(
    projectSlug,
    taskKey,
    fresh.length + toAdopt.length,
    fresh.reduce((sum, id) => sum + (bytes.get(id)?.length ?? 0), 0) +
      toAdopt.reduce((sum, look) => sum + (bytes.get(look.note)?.length ?? 0) + NOTE_SLACK_BYTES, 0),
    ctx.dataRoot,
  );
  if (room) return `${refused(room)} ${NOT_FROM_MEMORY}`;
  const by = { backend: actorRef.backend, profileId: actorRef.profileId, roleHint: actorRef.roleHint };
  const written: string[] = [];
  /** The id each of their sources is kept under here. */
  const here = new Map<string, string>();
  const keep = (theirId: string, data: Buffer, look: TaskSource["look"]): string | null => {
    const source = record.get(theirId);
    if (!source) return null;
    const kept = writeTaskSource(
      projectSlug,
      taskKey,
      {
        name: source.name,
        data,
        title: source.title,
        from: `${source.from} (kept on ${from} as ${source.id})`.slice(0, 2_000),
        by,
        runId: input.runId,
        look,
      },
      ctx.dataRoot,
    );
    if ("removed" in kept) return null;
    if ("kept" in kept) written.push(kept.kept.id);
    return "kept" in kept ? kept.kept.id : kept.already.id;
  };
  // Everything that can refuse was asked above, and nothing between there
  // and here waits: a write that still cannot land (the store changed under
  // this call) is a failure, which the tool answers as one, and what it left
  // is pictures with no note, so no look.
  for (const id of pictures) {
    const theirLook = record.get(id)?.look;
    const kept = keep(id, bytes.get(id) ?? Buffer.alloc(0), theirLook && { url: theirLook.url, at: theirLook.at, part: theirLook.part, view: theirLook.view });
    if (kept === null) throw new Error(`${id} of ${from} could not be kept on ${taskKey}`);
    here.set(id, kept);
  }
  const taken: string[] = [];
  for (const look of toAdopt) {
    const listed = look.pictures.map((picture) => ({ ...picture, id: here.get(picture.id) ?? picture.id }));
    const theirNote = (bytes.get(look.note) ?? Buffer.alloc(0)).toString("utf8");
    const cut = theirNote.indexOf(WHAT_MOVED_HEADING);
    const note = keep(look.note, Buffer.from(lookNote(look.url, look.at, listed, cut < 0 ? "" : theirNote.slice(cut))), {
      url: look.url,
      at: look.at,
      part: "note",
      view: null,
      pictures: listed,
    });
    // The note is what makes the pictures a look: one that was not written
    // new leaves none.
    if (note === null || written.at(-1) !== note) throw new Error(`the note of ${named(look)} could not be kept on ${taskKey}`);
    taken.push(`${named(look)} (${idRange(pictureIds(listed))}, with its note ${note})`);
  }
  const first = toAdopt[0]!;
  auditKept(db, input, { url: first.url, at: first.at, sources: written, from });
  return `[kept] ${taskKey} now keeps ${LIST_AND.format(taken)}, taken over from ${from}: the pictures byte for byte. ${HOW_TO_READ}`;
}

/** What a note may grow by when it is written again with another task's ids. */
const NOTE_SLACK_BYTES = 512;

/** The answer to an ask for an address the task already keeps a look of. */
function alreadyKept(taskKey: string, standing: KeptLook): string {
  return (
    `[noop] ${taskKey} already keeps how ${standing.url} looked on ${standing.at.slice(0, 10)} (${idRange(standing.stretches.map((s) => s.id))}). ` +
    "A result is judged against one look of an address: read that one. `read_task_source` lists every picture of it."
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
  if (standing) return alreadyKept(taskKey, standing);

  const answer = await pictureWebPage(db, ctx, { projectSlug, taskKey, url, runId: input.runId });
  if ("busy" in answer) return "[busy] The renderer is working on other pages. Call again in a moment.";
  if ("refused" in answer) {
    return `[error] ${url} could not be pictured: ${answer.refused}. Nothing was kept. Say in your report that the page could not be opened, and state nothing about its look from memory.`;
  }
  // The render took its time: another run's ask for the same address may
  // have kept its look meanwhile, and a task keeps one.
  const held = readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources;
  const meanwhile = keptLooks(held).find((look) => look.url === url);
  if (meanwhile) return alreadyKept(taskKey, meanwhile);
  // Whole or not at all: a look cut off by the task's limits would stand as
  // the look, with no note and no way to finish it.
  // Counted as it will be written: a frame or a stretch whose bytes the task
  // already keeps, or that equals one before it, is kept once.
  const seen = new Set(held.map((source) => source.sha256));
  const hashes = answer.pictures.map((picture) => createHash("sha256").update(picture.bytes).digest("hex"));
  // A picture whose bytes a person took out of this task's store is never
  // kept again (ruling 82), so the look cannot be whole here: said before
  // anything is written, and asking again would only picture the page again.
  const removed = removedAmong(ctx, projectSlug, taskKey, held, new Set(hashes));
  if (removed) {
    return `[error] A person took ${removed.id} out of ${taskKey}'s store, and it is a picture of this page as it looks today: the same bytes are not kept again, so the look of ${url} cannot be kept on this task. Nothing was kept. ${NOT_FROM_MEMORY}`;
  }
  const fresh = answer.pictures.filter((_picture, at) => {
    const hash = hashes[at]!;
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
  const room = sourcesRoomRefusal(
    projectSlug,
    taskKey,
    fresh.length + 1,
    fresh.reduce((sum, picture) => sum + picture.bytes.length, 0) + 8_192,
    ctx.dataRoot,
  );
  if (room) return `[error] ${room} Nothing was kept of ${url}. ${NOT_FROM_MEMORY}`;
  const at = new Date().toISOString();
  const by = { backend: actorRef.backend, profileId: actorRef.profileId, roleHint: actorRef.roleHint };
  /** The look's pictures, each with the source it is kept under. */
  const pictures: LookPicture[] = [];
  /** The sources this keep wrote. */
  const written: string[] = [];
  /** `again` is what would let a second ask keep it, where anything would. */
  const notKept = (why: string, again: string | null): string =>
    `[error] ${why} The look of ${url} was not kept. ` +
    (written.length > 0
      ? `The pictures written before that (${idRange(written)}) stay as sources and are no look${again ? `: asked again ${again}, they are taken up and not kept twice` : ""}. `
      : "Nothing was kept. ") +
    NOT_FROM_MEMORY;
  try {
    const listed = new Set<string>();
    for (const [index, picture] of answer.pictures.entries()) {
      const n = ordinalAmong(answer.pictures, index);
      const of = answer.pictures.filter((other) => other.view === picture.view && other.kind === picture.kind).length;
      const kept = writeTaskSource(
        projectSlug,
        taskKey,
        {
          name: pictureName(host, picture, n),
          data: picture.bytes,
          title: pictureTitle(host, picture, n, of),
          from: `${url}, pictured by Viberr at ${pageCaptureView(picture.view).width} px on ${at.slice(0, 10)}`,
          by,
          runId: input.runId,
          look: { url, at, part: picture.kind, view: picture.view },
        },
        ctx.dataRoot,
      );
      // Checked before the first write; a picture taken out of the store in
      // the moment since is answered the same way.
      if ("removed" in kept) {
        return notKept(`A person took one of this page's pictures (${kept.removed.id}) out of ${taskKey}'s store, and the same bytes are not kept again.`, null);
      }
      // Bytes the task already keeps are this look's picture under the id
      // they have: what an earlier keep that failed left behind, or a part of
      // the page that looks the same as another, which the note says.
      const source = "kept" in kept ? kept.kept : kept.already;
      if ("kept" in kept) written.push(source.id);
      if (picture.kind === "stretch") {
        pictures.push({
          id: source.id,
          part: "stretch",
          view: picture.view,
          from: picture.from,
          to: picture.to,
          pageHeight: picture.pageHeight,
          cut: picture.cut,
        });
        // A frame equal to a picture already listed is a moment at which
        // nothing had moved: the picture it equals stands for both.
      } else if (!listed.has(source.id)) {
        pictures.push({ id: source.id, part: "frame", view: picture.view, moment: picture.moment ?? 0 });
      }
      listed.add(source.id);
    }
    const note = writeTaskSource(
      projectSlug,
      taskKey,
      {
        name: `${host}-what-moved.md`,
        data: Buffer.from(lookNote(url, at, pictures, whatMoved(answer.motion, answer.scrollsInside))),
        title: `${host}: where its pictures are, and what moved on it`,
        from: `${url}, read by Viberr's renderer on ${at.slice(0, 10)}`,
        by,
        runId: input.runId,
        look: { url, at, part: "note", view: null, pictures },
      },
      ctx.dataRoot,
    );
    // The note is what makes the pictures a look.
    if (!("kept" in note)) return notKept("The note that closes the look could not be written.", null);
    written.push(note.kept.id);
    auditKept(db, input, { url, at, sources: written, from: null });
    const parts = [`[kept] How ${url} looked on ${at.slice(0, 10)} is kept on ${taskKey}.`];
    for (const view of PAGE_CAPTURE_VIEWS) {
      const { kept, repeats } = stretchesAt(pictures, view.id);
      if (kept.length === 0) continue;
      parts.push(`${view.label}: ${idRange(kept.map((entry) => entry.id))}, ${stretchesSentence(kept, repeats)}`);
    }
    const frames = pictures.filter((entry) => entry.part === "frame");
    if (frames.length > 0) parts.push(`Its first screen while it loaded: ${idRange(frames.map((entry) => entry.id))}.`);
    parts.push(...insideSentences(answer.scrollsInside));
    parts.push(`Where each picture is and what moved on the page, as measured: ${note.kept.id}.`);
    parts.push(HOW_TO_READ);
    return parts.join(" ");
  } catch (error) {
    // The store's own sentence for a task that has no room left.
    if (isAppError(error) && error.code === ERROR_CODES.VALIDATION_FAILED) return notKept(error.userMessage, "once there is room");
    throw error;
  }
}
