import type {
  HighlighterCore,
  LanguageRegistration,
  ThemedToken,
} from "shiki/types";

/**
 * Ruling 363: Shiki, loaded late and small.
 *
 * The reader highlights with Shiki — VS Code's TextMate grammars, the same
 * lineage Codex's own renderer (syntect) and every editor the owner reads code
 * in use — but none of it ships with the task page. `shiki/core` and the
 * JavaScript regex engine (no WebAssembly) load on the first file opened; each
 * grammar is its own chunk, fetched the first time a file of that language
 * opens. The css-variables theme is the only theme: every token resolves to
 * one of nine scope families, which `toToken` turns into a class the
 * stylesheet colours from the `--syn-*` palette — no inline colours, both
 * themes served by `app.css` alone.
 *
 * Highlighting is decoration. The text is on screen before any of this runs,
 * and every failure here (a grammar that will not load, an engine the browser
 * cannot build, a file that takes too long) resolves to `null`, which leaves
 * the plain lines exactly as they were.
 */

/** One token of one line: its text and the class its scope family earned
 *  (`undefined` = the foreground, rendered as a bare text node). */
export interface CodeToken {
  text: string;
  className: string | undefined;
}

/** A grammar module the highlighter accepts as a lazy language input. */
export type GrammarLoader = () => Promise<{ default: LanguageRegistration[] }>;

/** The grammar chunk for each language id `code-language.ts` can name.
 *  Literal import paths on purpose — Vite splits each into its own chunk. */
export const LANGUAGE_LOADERS: ReadonlyMap<string, GrammarLoader> = new Map<
  string,
  GrammarLoader
>([
  ["javascript", () => import("@shikijs/langs/javascript")],
  ["jsx", () => import("@shikijs/langs/jsx")],
  ["typescript", () => import("@shikijs/langs/typescript")],
  ["tsx", () => import("@shikijs/langs/tsx")],
  ["json", () => import("@shikijs/langs/json")],
  ["jsonc", () => import("@shikijs/langs/jsonc")],
  ["json5", () => import("@shikijs/langs/json5")],
  ["jsonl", () => import("@shikijs/langs/jsonl")],
  ["yaml", () => import("@shikijs/langs/yaml")],
  ["toml", () => import("@shikijs/langs/toml")],
  ["ini", () => import("@shikijs/langs/ini")],
  ["properties", () => import("@shikijs/langs/properties")],
  ["dotenv", () => import("@shikijs/langs/dotenv")],
  ["markdown", () => import("@shikijs/langs/markdown")],
  ["mdx", () => import("@shikijs/langs/mdx")],
  ["html", () => import("@shikijs/langs/html")],
  ["xml", () => import("@shikijs/langs/xml")],
  ["css", () => import("@shikijs/langs/css")],
  ["scss", () => import("@shikijs/langs/scss")],
  ["sass", () => import("@shikijs/langs/sass")],
  ["less", () => import("@shikijs/langs/less")],
  ["python", () => import("@shikijs/langs/python")],
  ["shellscript", () => import("@shikijs/langs/shellscript")],
  ["fish", () => import("@shikijs/langs/fish")],
  ["powershell", () => import("@shikijs/langs/powershell")],
  ["bat", () => import("@shikijs/langs/bat")],
  ["sql", () => import("@shikijs/langs/sql")],
  ["go", () => import("@shikijs/langs/go")],
  ["rust", () => import("@shikijs/langs/rust")],
  ["java", () => import("@shikijs/langs/java")],
  ["kotlin", () => import("@shikijs/langs/kotlin")],
  ["ruby", () => import("@shikijs/langs/ruby")],
  ["php", () => import("@shikijs/langs/php")],
  ["c", () => import("@shikijs/langs/c")],
  ["cpp", () => import("@shikijs/langs/cpp")],
  ["csharp", () => import("@shikijs/langs/csharp")],
  ["swift", () => import("@shikijs/langs/swift")],
  ["objective-c", () => import("@shikijs/langs/objective-c")],
  ["graphql", () => import("@shikijs/langs/graphql")],
  ["proto", () => import("@shikijs/langs/proto")],
  ["docker", () => import("@shikijs/langs/docker")],
  ["vue", () => import("@shikijs/langs/vue")],
  ["svelte", () => import("@shikijs/langs/svelte")],
  ["astro", () => import("@shikijs/langs/astro")],
  ["terraform", () => import("@shikijs/langs/terraform")],
  ["hcl", () => import("@shikijs/langs/hcl")],
  ["lua", () => import("@shikijs/langs/lua")],
  ["r", () => import("@shikijs/langs/r")],
  ["perl", () => import("@shikijs/langs/perl")],
  ["diff", () => import("@shikijs/langs/diff")],
  ["log", () => import("@shikijs/langs/log")],
  ["csv", () => import("@shikijs/langs/csv")],
  ["tsv", () => import("@shikijs/langs/tsv")],
  ["nginx", () => import("@shikijs/langs/nginx")],
  ["prisma", () => import("@shikijs/langs/prisma")],
  ["nix", () => import("@shikijs/langs/nix")],
  ["zig", () => import("@shikijs/langs/zig")],
  ["dart", () => import("@shikijs/langs/dart")],
  ["scala", () => import("@shikijs/langs/scala")],
  ["groovy", () => import("@shikijs/langs/groovy")],
  ["elixir", () => import("@shikijs/langs/elixir")],
  ["erlang", () => import("@shikijs/langs/erlang")],
  ["haskell", () => import("@shikijs/langs/haskell")],
  ["clojure", () => import("@shikijs/langs/clojure")],
  ["elm", () => import("@shikijs/langs/elm")],
  ["latex", () => import("@shikijs/langs/latex")],
  ["http", () => import("@shikijs/langs/http")],
  ["mermaid", () => import("@shikijs/langs/mermaid")],
  ["cmake", () => import("@shikijs/langs/cmake")],
  ["make", () => import("@shikijs/langs/make")],
  ["vim", () => import("@shikijs/langs/vim")],
  ["codeowners", () => import("@shikijs/langs/codeowners")],
]);

const THEME = "css-variables";

/** A line longer than this is one plain token — a minified bundle is not
 *  something a regex grammar should be asked to parse character by character. */
const MAX_TOKENIZED_LINE = 1_000;

let corePromise: Promise<HighlighterCore> | null = null;

/** The one highlighter, built on first use; a failed build is forgotten so
 *  the next file tries again instead of inheriting the rejection. */
function core(): Promise<HighlighterCore> {
  if (corePromise) return corePromise;
  const attempt = Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]).then(([shiki, js]) =>
    shiki.createHighlighterCore({
      themes: [
        shiki.createCssVariablesTheme({
          name: THEME,
          variablePrefix: "--shiki-",
          fontStyle: true,
        }),
      ],
      langs: [],
      engine: js.createJavaScriptRegexEngine(),
    }),
  );
  corePromise = attempt;
  attempt.catch(() => {
    if (corePromise === attempt) corePromise = null;
  });
  return attempt;
}

/**
 * Tokenize `text` as `language`. `null` when the language has no grammar here
 * or anything in the pipeline fails — the caller keeps its plain rendering.
 */
export async function highlightCode(
  text: string,
  language: string,
): Promise<CodeToken[][] | null> {
  const load = LANGUAGE_LOADERS.get(language);
  if (!load) return null;
  try {
    const highlighter = await core();
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(load);
    }
    const lines = highlighter.codeToTokensBase(text, {
      lang: language,
      theme: THEME,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      includeExplanation: false,
    });
    return lines.map((line) => line.map(toToken));
  } catch {
    return null;
  }
}

/** `var(--shiki-token-keyword)` → `tk-keyword`; the foreground → no class. */
const TOKEN_VAR = /^var\(--shiki-token-([a-z-]+)\)$/;

// vscode-textmate's FontStyle bits — Italic 1, Bold 2, Underline 4.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

export function toToken(token: ThemedToken): CodeToken {
  const classes: string[] = [];
  const family = token.color ? TOKEN_VAR.exec(token.color) : null;
  if (family) classes.push(`tk-${family[1]}`);
  const style = token.fontStyle ?? 0;
  if (style > 0) {
    if (style & ITALIC) classes.push("tk-i");
    if (style & BOLD) classes.push("tk-b");
    if (style & UNDERLINE) classes.push("tk-u");
  }
  return {
    text: token.content,
    className: classes.length > 0 ? classes.join(" ") : undefined,
  };
}
