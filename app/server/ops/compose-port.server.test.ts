import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composePort } from "./compose-port.server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("composePort (the port `npm run deploy` verifies on)", () => {
  it("falls back to the default with no shell PORT and no .env", () => {
    expect(composePort({}, null)).toBe("3000");
  });

  it("reads PORT out of .env the way compose does", () => {
    expect(composePort({}, "VIBERR_DATA_ROOT=./docker-data\nPORT=5173\n")).toBe("5173");
    expect(composePort({}, 'PORT="5174" # the dev port\n')).toBe("5174");
    expect(composePort({}, "export PORT=5175\n")).toBe("5175");
    expect(composePort({}, "PORT=4000\nPORT=5176\n")).toBe("5176");
  });

  it("treats a commented or empty PORT as unset, as `${PORT:-3000}` does", () => {
    // `.env.example` ships the line commented out, so this is the default setup.
    expect(composePort({}, "#PORT=5173\n")).toBe("3000");
    expect(composePort({}, "PORT=\n")).toBe("3000");
  });

  it("lets the invoking shell win over .env, even with an empty value", () => {
    expect(composePort({ PORT: "4000" }, "PORT=5173\n")).toBe("4000");
    expect(composePort({ PORT: "" }, "PORT=5173\n")).toBe("3000");
  });

  it("defaults to the port compose.yml and the Dockerfile default to", () => {
    // CANARY: the bug this module replaced was the deploy script and compose
    // disagreeing about a port. Change either default and this fails.
    const port = composePort({}, null);
    expect(read("compose.yml")).toContain(`"\${PORT:-${port}}:\${PORT:-${port}}"`);
    expect(read("Dockerfile")).toMatch(new RegExp(`^ENV PORT=${port}$`, "m"));
  });

  it("is what scripts/deploy.ts polls, not a literal port", () => {
    const deploy = read("scripts/deploy.ts");
    expect(deploy).toContain("composePort(process.env, readDotenv())");
    expect(deploy).not.toMatch(/127\.0\.0\.1:\d/);
  });
});
