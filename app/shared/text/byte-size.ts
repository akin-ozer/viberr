/**
 * A byte count as a person reads it: "512 B", "1.5 KB", "2.0 MB". Client-safe,
 * so the store browser, a task's attachments and every composer's file tray
 * (ruling 319) print a size the same way.
 */
export function prettySize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
