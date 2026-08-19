import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "~/server/errors/app-error.server";
import { writeFileAtomic, type AtomicFileFsOps } from "./atomic-file.server";

// The failure classes writeFileAtomic must distinguish (ENOSPC/ESTALE/EIO)
// cannot be produced by a real volume on demand — inject them through the
// module's own `fsImpl` seam instead.
const fs = {
  mkdirSync: vi.fn<AtomicFileFsOps["mkdirSync"]>(),
  writeFileSync: vi.fn<AtomicFileFsOps["writeFileSync"]>(),
  renameSync: vi.fn<AtomicFileFsOps["renameSync"]>(),
  rmSync: vi.fn<AtomicFileFsOps["rmSync"]>(),
};

function errno(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: injected`);
  e.code = code;
  return e;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeFileAtomic", () => {
  it("writes to a *.tmp sibling then renames over the target", () => {
    writeFileAtomic("/data/projects/p/project.md", "body", { fsImpl: fs });
    expect(fs.mkdirSync).toHaveBeenCalledWith("/data/projects/p", {
      recursive: true,
    });
    const tmp = fs.writeFileSync.mock.calls[0]![0];
    expect(tmp).toMatch(/\/data\/projects\/p\/project\.md\.[0-9a-f]+\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(tmp, "/data/projects/p/project.md");
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it("the default seam is the real node:fs — the write really lands, atomically", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-atomic-"));
    try {
      const target = path.join(dir, "nested", "note.md");
      writeFileAtomic(target, "body");
      expect(readFileSync(target, "utf8")).toBe("body");
      // No *.tmp staging file left beside the target.
      expect(readdirSync(path.dirname(target))).toEqual(["note.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ENOSPC → a plain, actionable Error and the staging file is swept", () => {
    fs.writeFileSync.mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });
    let caught: unknown;
    try {
      writeFileAtomic("/data/x.md", "body", { fsImpl: fs });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // SAFETY: the assertion above already failed the test if it is not one.
    expect((caught as Error).message).toMatch(/No space left on the data root/);
    // The tmp file is cleaned up before the error is raised (Gap 16).
    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  it("F20-1: ESTALE (write) → a typed AppError naming the data root as unreachable", () => {
    fs.writeFileSync.mockImplementationOnce(() => {
      throw errno("ESTALE");
    });
    let caught: unknown;
    try {
      writeFileAtomic("/data/projects/p/project.md", "body", { fsImpl: fs });
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.status).toBe(503);
      expect(caught.userMessage).toMatch(/data root is unreachable \(ESTALE\)/);
      expect(caught.userMessage).toContain("/data/projects/p/project.md");
    }
    expect(fs.rmSync).toHaveBeenCalledTimes(1); // still swept
  });

  it("F20-1: EIO (rename) → a typed AppError; the write never retries or spins", () => {
    fs.renameSync.mockImplementationOnce(() => {
      throw errno("EIO");
    });
    let caught: unknown;
    try {
      writeFileAtomic("/data/x.md", "body", { fsImpl: fs });
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.status).toBe(503);
      expect(caught.userMessage).toMatch(/unreachable \(EIO\)/);
    }
    // writeFileSync ran exactly once — no retry loop (the spin the fix removes).
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("an unrelated errno is re-thrown unchanged (no typing, no swallow)", () => {
    fs.writeFileSync.mockImplementationOnce(() => {
      throw errno("EACCES");
    });
    let caught: unknown;
    try {
      writeFileAtomic("/data/x.md", "body", { fsImpl: fs });
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(false);
    // SAFETY: the mock above threw the ErrnoException this helper built, and
    // what is asserted here is that writeFileAtomic re-threw that same value.
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
  });
});
