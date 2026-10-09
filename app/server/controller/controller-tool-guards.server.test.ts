import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { imageResult } from "~/server/runtimes/strict-tool.server";
import { controllerToolGuards } from "./controller-tool-guards.server";

/**
 * Ruling 260: what leaves a controller tool is never longer than a turn
 * carries. The CLI passes a text result of at most 50,000 characters as it is
 * and may refuse a longer one, handing the model a file path with advice to
 * grep it, which the controller has no tool for: on the AWS calculator board
 * `get_project` did that on three turns out of three.
 */
describe("ruling 260: a controller tool reply longer than a turn carries", () => {
  const guards = controllerToolGuards(
    new DatabaseSync(":memory:"),
    { id: "u_1", email: "arda@viberr.test", name: "Arda" },
  );
  const reply = async (answer: string) => {
    const result = await guards.run(() => answer)();
    const [part] = result.content;
    if (part?.type !== "text") throw new Error("expected a text reply");
    return part.text;
  };

  it("is cut at a line break, under the cap, and says so with the sizes before anything else", async () => {
    // CANARY: return the handler's text without `carriedReply` and the whole
    // 100,000 characters go out, for the CLI to replace with a file the
    // controller cannot open.
    const line = `${"x".repeat(99)}\n`;
    const text = await reply(line.repeat(1_000));
    const at = text.indexOf("\n");
    const note = text.slice(0, at);
    const body = text.slice(at + 1);
    expect(note).toBe(
      `[cut] This reply is 100,000 characters and a turn carries 50,000: what follows is its first ${body.length.toLocaleString("en-US")}, ` +
        "and the rest is not here. Ask for less (one item, a limit, a later page) rather than taking this as the whole of it.",
    );
    expect(text.length).toBeLessThanOrEqual(50_000);
    // Whole lines only, and nearly all the room is used.
    expect(body.split("\n").every((kept) => kept === "x".repeat(99))).toBe(true);
    expect(body.length).toBeGreaterThan(49_000);
  });

  it("keeps the room it has when the reply is mostly one line", async () => {
    // CANARY: always step back to the last line break and a document carried
    // inside one JSON string is cut to the two lines above it: 40 characters
    // of a 100,000-character reply.
    const text = await reply(`{\n "path": "notes.md",\n "text": "${"n".repeat(100_000)}"\n}`);
    const body = text.slice(text.indexOf("\n") + 1);
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(body.length).toBeGreaterThan(49_000);
    expect(body.startsWith('{\n "path": "notes.md",\n "text": "nnnn')).toBe(true);
  });

  it("is never cut between the two halves of a character", async () => {
    // CANARY: slice at the room's end whatever stands there and the head ends
    // in half of a character, which no reader can print.
    // One of the two leads puts a pair across the cut, whatever the note's
    // own length makes the room.
    for (const lead of ["", "a"]) {
      const text = await reply(lead + "😀".repeat(30_000));
      const body = text.slice(text.indexOf("\n") + 1);
      expect(text.length).toBeLessThanOrEqual(50_000);
      expect(body).toBe(lead + "😀".repeat((body.length - lead.length) / 2));
    }
  });

  it("leaves a reply within the cap, and a picture, as they are", async () => {
    // CANARY: cut at any length and a 50,000-character page arrives with a
    // note claiming part of it is missing.
    const page = "y".repeat(50_000);
    expect(await reply(page)).toBe(page);
    // CANARY: count bytes and a reply in an alphabet of two-byte letters is
    // cut at half the length the CLI passes untouched.
    const letters = "ğ".repeat(50_000);
    expect(await reply(letters)).toBe(letters);
    const picture = await guards.run(() => imageResult("a.png, attached.", { data: "z".repeat(90_000), mimeType: "image/png" }))();
    expect(picture.content).toEqual([
      { type: "text", text: "a.png, attached." },
      { type: "image", data: "z".repeat(90_000), mimeType: "image/png" },
    ]);
  });
});
