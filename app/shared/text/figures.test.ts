import { describe, expect, it } from "vitest";
import { formatDuration } from "./figures";

describe("formatDuration", () => {
  it("ruling 316: prints a span from two days up in days and hours, and a shorter one as Insights always has", () => {
    // CANARY: drop the days arm and a task that waited a week on a person
    // reads "168h 0m" on its card and on Insights.
    const MIN = 60_000;
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(35 * MIN)).toBe("35m");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(47 * 60 * MIN + 59 * MIN)).toBe("47h 59m");
    expect(formatDuration(48 * 60 * MIN)).toBe("2d 0h");
    expect(formatDuration(7 * 24 * 60 * MIN + 5 * 60 * MIN)).toBe("7d 5h");
    expect(formatDuration(null)).toBe("n/a");
  });
});
