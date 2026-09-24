import { describe, expect, it } from "vitest";
import { BACKEND_LABEL } from "./backend-label";

describe("BACKEND_LABEL", () => {
  it("names the two backends as ruling 92 spells them", () => {
    expect(BACKEND_LABEL).toEqual({ claude: "Claude", codex: "Codex" });
  });
});
