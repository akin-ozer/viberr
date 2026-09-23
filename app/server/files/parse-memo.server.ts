/**
 * Ruling 454: the store readers' parse counter (the measurement the parse memo
 * is judged by). Every canonical-file read that parses YAML goes through
 * {@link parseStoreFile}.
 */

export type StoreFileKind = "project-file" | "task-file" | "agent-profile";

/** YAML parses per kind of store file. */
export interface StoreFileParseCounts {
  "project-file": number;
  "task-file": number;
  "agent-profile": number;
}

const parses: StoreFileParseCounts = {
  "project-file": 0,
  "task-file": 0,
  "agent-profile": 0,
};

/** Parses `content` read from `absPath`. */
export function parseStoreFile<T>(
  kind: StoreFileKind,
  _absPath: string,
  _variant: string,
  content: string,
  parse: (content: string) => T,
): T {
  parses[kind] += 1;
  return parse(content);
}

/** test-only: YAML parses per kind since the last reset. */
export function storeFileParseCounts(): StoreFileParseCounts {
  return { ...parses };
}

/** test-only: zero the counters. */
export function resetParseMemoForTests(): void {
  parses["project-file"] = 0;
  parses["task-file"] = 0;
  parses["agent-profile"] = 0;
}
