/**
 * Ruling 317: which grammar a filename gets in the code reader.
 *
 * Extension first, then the handful of bare names that carry their language
 * (`Dockerfile`, `Makefile`), then the dotfile families (`.env.local`). Every
 * id returned here has a loader in `code-highlight.ts` — `code-language.test.ts`
 * walks both tables so a name can never resolve to a grammar the reader
 * cannot fetch. Anything unmapped is `"text"`: the reader still shows it,
 * with line numbers, just unhighlighted — an unknown extension is not a
 * reason to hide a file behind "no preview".
 */

/** Unhighlighted: the reader's plain rendering. */
export const PLAIN_LANGUAGE = "text";

const BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["tsx", "tsx"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["json5", "json5"],
  ["jsonl", "jsonl"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["ini", "ini"],
  ["cfg", "ini"],
  ["conf", "ini"],
  ["properties", "properties"],
  ["env", "dotenv"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["mdx", "mdx"],
  ["html", "html"],
  ["htm", "html"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["xsl", "xml"],
  ["plist", "xml"],
  ["css", "css"],
  ["scss", "scss"],
  ["sass", "sass"],
  ["less", "less"],
  ["py", "python"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["zsh", "shellscript"],
  ["fish", "fish"],
  ["ps1", "powershell"],
  ["bat", "bat"],
  ["cmd", "bat"],
  ["sql", "sql"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["rb", "ruby"],
  ["php", "php"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["cs", "csharp"],
  ["swift", "swift"],
  ["m", "objective-c"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["proto", "proto"],
  ["dockerfile", "docker"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
  ["tf", "terraform"],
  ["tfvars", "terraform"],
  ["hcl", "hcl"],
  ["lua", "lua"],
  ["r", "r"],
  ["pl", "perl"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["log", "log"],
  ["csv", "csv"],
  ["tsv", "tsv"],
  ["nginx", "nginx"],
  ["prisma", "prisma"],
  ["nix", "nix"],
  ["zig", "zig"],
  ["dart", "dart"],
  ["scala", "scala"],
  ["groovy", "groovy"],
  ["gradle", "groovy"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["erl", "erlang"],
  ["hs", "haskell"],
  ["clj", "clojure"],
  ["elm", "elm"],
  ["tex", "latex"],
  ["http", "http"],
  ["mermaid", "mermaid"],
  ["mmd", "mermaid"],
  ["cmake", "cmake"],
  ["mk", "make"],
  ["vim", "vim"],
]);

/** Bare names whose language is the name itself (lower-cased). */
const BY_NAME: ReadonlyMap<string, string> = new Map([
  ["dockerfile", "docker"],
  ["containerfile", "docker"],
  ["makefile", "make"],
  ["gnumakefile", "make"],
  ["cmakelists.txt", "cmake"],
  ["codeowners", "codeowners"],
  [".editorconfig", "ini"],
  [".npmrc", "ini"],
  [".gitconfig", "ini"],
]);

/** Shiki grammar id for a filename, or `PLAIN_LANGUAGE`. */
export function languageForName(name: string): string {
  const lower = name.toLowerCase();
  const byName = BY_NAME.get(lower);
  if (byName) return byName;
  // `.env`, `.env.local`, `.env.production` — the family, not one extension.
  if (lower === ".env" || lower.startsWith(".env.")) return "dotenv";
  return BY_EXTENSION.get(extensionOf(lower)) ?? PLAIN_LANGUAGE;
}

/**
 * Ruling 317: whether a file opens rendered as markdown (`.md`, `.markdown`),
 * read off the same table, so a name it learns needs no second list. `.mdx`
 * stays source: its JSX and imports are not markdown, and rendered they would
 * print as stray text.
 */
export function isMarkdownName(name: string): boolean {
  return languageForName(name) === "markdown";
}

/** The part after the last dot, or "" without one. A dot-leading name
 *  (`.bashrc`) has no extension in this sense: `.env` is handled above. */
function extensionOf(lower: string): string {
  const dot = lower.lastIndexOf(".");
  return dot <= 0 ? "" : lower.slice(dot + 1);
}

/** Every grammar id the name tables can produce — what the loader table
 *  must cover (the test walks it). */
export function mappedLanguages(): ReadonlySet<string> {
  return new Set([...BY_EXTENSION.values(), ...BY_NAME.values(), "dotenv"]);
}
