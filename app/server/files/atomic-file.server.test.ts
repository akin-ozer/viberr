import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "~/server/errors/app-error.server";

// Mock node:fs so we can inject the failure classes writeFileAtomic must
// distinguish. Shared handles via vi.hoisted so the factory (hoisted above the
// imports) and the tests reference the same mocks.
const fs = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("node:fs", () => fs);

import { writeFileAtomic } from "./atomic-file.server";

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: injected`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeFileAtomic", () => {
  it("writes to a *.tmp sibling then renames over the target", () => {
    writeFileAtomic("/data/projects/p/project.md", "body");
    expect(fs.mkdirSync).toHaveBeenCalledWith("/data/projects/p", {
      recursive: true,
    });
    const tmp = fs.writeFileSync.mock.calls[0]?.[0] as string;
    expect(tmp).toMatch(/\/data\/projects\/p\/project\.md\.[0-9a-f]+\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(tmp, "/data/projects/p/project.md");
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it("ENOSPC → a plain, actionable Error and the staging file is swept", () => {
    fs.writeFileSync.mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });
    let caught: unknown;
    try {
      writeFileAtomic("/data/x.md", "body");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
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
      writeFileAtomic("/data/projects/p/project.md", "body");
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
      writeFileAtomic("/data/x.md", "body");
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
      writeFileAtomic("/data/x.md", "body");
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(false);
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
  });
});
