/**
 * U33-8: `?c=new` — the blank composer, asked for by name.
 *
 * Ruling 121 gave the DOCK a continuity rule: with nothing selected it opens
 * the newest thread of the scope you are standing in. This page opened an
 * empty composer instead, so the same person, on the same scope, got a
 * different answer depending on which entry point they used. The page now
 * follows the dock — which leaves "start a fresh thread" needing a token of
 * its own. It is the same `"new"` the dock sends (`DOCK_NEW_CONVERSATION` in
 * controller-dock-query.server.ts); `selectedConversationId` in
 * controller-query.server.ts resolves it for both route loaders, and
 * controller-page.tsx writes it into the New link.
 *
 * It lives in this import-free leaf so the server query can read it without
 * importing the page component.
 */
export const NEW_CONVERSATION_PARAM = "new";
