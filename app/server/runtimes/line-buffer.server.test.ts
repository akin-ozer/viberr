import { describe, expect, it } from "vitest";
import { createLineBuffer } from "./line-buffer.server";

describe("createLineBuffer", () => {
  const collect = () => {
    const jsons: unknown[] = [];
    const raws: string[] = [];
    const invalid: string[] = [];
    const lb = createLineBuffer({
      onJson: (v, raw) => {
        jsons.push(v);
        raws.push(raw);
      },
      onInvalid: (raw) => invalid.push(raw),
    });
    return { lb, jsons, raws, invalid };
  };

  it("parses whole lines split on newline", () => {
    const { lb, jsons } = collect();
    lb.push('{"type":"a"}\n{"type":"b"}\n');
    expect(jsons).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("handles a line straddling two chunks (#1 naive-parser bug)", () => {
    const { lb, jsons } = collect();
    lb.push('{"type":"thread.star');
    lb.push('ted","thread_id":"t1"}\n');
    expect(jsons).toEqual([{ type: "thread.started", thread_id: "t1" }]);
  });

  it("handles multiple events + a partial in one chunk, flushed later", () => {
    const { lb, jsons } = collect();
    lb.push('{"a":1}\n{"b":2}\n{"c":');
    expect(jsons).toEqual([{ a: 1 }, { b: 2 }]);
    lb.push("3}\n");
    expect(jsons).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("flush emits a trailing line with no newline", () => {
    const { lb, jsons } = collect();
    lb.push('{"final":true}');
    expect(jsons).toEqual([]);
    lb.flush();
    expect(jsons).toEqual([{ final: true }]);
  });

  it("ignores blank lines, surfaces invalid JSON via onInvalid (never throws)", () => {
    const { lb, jsons, invalid } = collect();
    lb.push("\n\n");
    lb.push("not json\n");
    lb.push('{"ok":1}\n');
    expect(jsons).toEqual([{ ok: 1 }]);
    expect(invalid).toEqual(["not json"]);
  });

  it("splits a chunk arriving byte-by-byte", () => {
    const { lb, jsons } = collect();
    const payload = '{"type":"turn.completed","usage":{"input_tokens":5}}\n';
    for (const ch of payload) lb.push(ch);
    expect(jsons).toEqual([{ type: "turn.completed", usage: { input_tokens: 5 } }]);
  });
});
