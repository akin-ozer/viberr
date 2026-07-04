import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPathDebouncer } from "./path-debounce.server";

describe("createPathDebouncer (the watcher's 250ms coalescer)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a burst of events for one path flushes exactly once, trailing", () => {
    const flushed: string[] = [];
    const debouncer = createPathDebouncer(250, (key) => flushed.push(key));

    debouncer.schedule("/a/task.md");
    vi.advanceTimersByTime(100);
    debouncer.schedule("/a/task.md");
    vi.advanceTimersByTime(100);
    debouncer.schedule("/a/task.md");
    expect(flushed).toEqual([]); // still pending — timer keeps resetting

    vi.advanceTimersByTime(249);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual(["/a/task.md"]);

    vi.advanceTimersByTime(1000);
    expect(flushed).toEqual(["/a/task.md"]); // no second flush
  });

  it("different paths debounce independently", () => {
    const flushed: string[] = [];
    const debouncer = createPathDebouncer(250, (key) => flushed.push(key));

    debouncer.schedule("/a/task.md");
    vi.advanceTimersByTime(200);
    debouncer.schedule("/b/task.md");
    expect(debouncer.pendingCount()).toBe(2);

    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(["/a/task.md"]);
    vi.advanceTimersByTime(200);
    expect(flushed).toEqual(["/a/task.md", "/b/task.md"]);
    expect(debouncer.pendingCount()).toBe(0);
  });

  it("cancelAll drops pending flushes", () => {
    const flushed: string[] = [];
    const debouncer = createPathDebouncer(250, (key) => flushed.push(key));
    debouncer.schedule("/a/task.md");
    debouncer.schedule("/b/task.md");
    debouncer.cancelAll();
    vi.advanceTimersByTime(1000);
    expect(flushed).toEqual([]);
    expect(debouncer.pendingCount()).toBe(0);
  });

  it("a new schedule after a flush starts a fresh cycle", () => {
    const flushed: string[] = [];
    const debouncer = createPathDebouncer(250, (key) => flushed.push(key));
    debouncer.schedule("/a/task.md");
    vi.advanceTimersByTime(250);
    debouncer.schedule("/a/task.md");
    vi.advanceTimersByTime(250);
    expect(flushed).toEqual(["/a/task.md", "/a/task.md"]);
  });
});
