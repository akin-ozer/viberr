/**
 * The ONE list of file extensions Viberr treats as a store text document.
 *
 * It answers three questions that must never diverge:
 *   - will this file's bytes reach an agent run? (`isInjectableKbDoc`, the
 *     injector in `~/server/files/kb-injection.server`)
 *   - will the in-app editor create/read it? (`~/server/org/store-files.server`)
 *   - is its row clickable in the store browser? (`~/features/kb-browser/
 *     store-browser`, which runs in the browser and so cannot import either
 *     `.server` module — that is why this file exists rather than the set
 *     simply living next to the injector)
 *
 * P14-KM-13 was the first half of this defect: the org-settings row counted
 * EVERY non-dot file as a "doc", so a KB holding nothing but PDFs advertised a
 * healthy count while injecting zero bytes. Pass 16 closed the second half —
 * the injector, the editor and the browser each kept their own hand-maintained
 * copy, which is exactly how the first divergence happened. The editor list was
 * kept separate on the theory that it might one day open a format we would not
 * inject; that list is still empty, so one set serves all three and the theory
 * can be revisited by adding a second export here, in the open.
 *
 * `.json`/`.yaml`/`.yml` are included deliberately: authoring a dead-end format
 * in-app is the silent-resource failure this pass exists to close, and
 * structured config/spec docs are perfectly good agent context.
 */
export const STORE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rst",
  ".text",
  ".json",
  ".yaml",
  ".yml",
]);

/** Rendered form for the "we only accept these" error and hint copy. */
export const STORE_TEXT_EXTENSION_LIST: readonly string[] = [
  ...STORE_TEXT_EXTENSIONS,
];
