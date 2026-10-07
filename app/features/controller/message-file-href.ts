import type { MessageFile } from "~/server/controller/controller-conversations.server";

// Lives apart from message-files.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/** Ruling 573: where a file sent in a conversation is served. */
export function messageFileHref(file: Pick<MessageFile, "id">): string {
  return `/resources/controller-file/${encodeURIComponent(file.id)}`;
}
