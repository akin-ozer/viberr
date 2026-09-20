import { describe, expect, it } from "vitest";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { LANGUAGE_LOADERS } from "./code-highlight";
import { languageForName, mappedLanguages, PLAIN_LANGUAGE } from "./code-language";

/* Ruling 363: the name → grammar table, and the promise that every grammar it
   names can actually be fetched. */
describe("code-language (ruling 363)", () => {
  it("maps by extension, by bare name and by the .env family; unknown names read plain", () => {
    expect(languageForName("shop-65-journey-script.mjs")).toBe("javascript");
    expect(languageForName("Board.TSX")).toBe("tsx");
    expect(languageForName("Dockerfile")).toBe("docker");
    expect(languageForName("Makefile")).toBe("make");
    expect(languageForName(".env.local")).toBe("dotenv");
    expect(languageForName("icon.svg")).toBe("xml");
    expect(languageForName("console-1.log")).toBe("log");
    expect(languageForName("capture.yml")).toBe("yaml");
    // No grammar is not no reader: these open plain, numbered.
    expect(languageForName("notes.txt")).toBe(PLAIN_LANGUAGE);
    expect(languageForName("yarn.lock")).toBe(PLAIN_LANGUAGE);
    expect(languageForName(".bashrc")).toBe(PLAIN_LANGUAGE);
    expect(languageForName("README")).toBe(PLAIN_LANGUAGE);
  });

  it("every language a name can resolve to has a grammar loader", () => {
    const missing = [...mappedLanguages()].filter((id) => !LANGUAGE_LOADERS.has(id));
    expect(missing).toEqual([]);
  });

  it("every loader loads into Shiki under its own id", async () => {
    const highlighter = await createHighlighterCore({
      themes: [],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    for (const [id, load] of LANGUAGE_LOADERS) {
      await highlighter.loadLanguage(load);
      expect(highlighter.getLoadedLanguages(), id).toContain(id);
    }
  });
});
