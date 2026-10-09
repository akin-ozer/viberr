import { useEffect, useMemo, useRef } from "react";

/**
 * Which of a conversation's messages arrived while it was on screen, for the
 * entry motion (`.ctl-msg[data-fresh]`), one rule for the dock and the full
 * controller page (ruling 284(a)). Ids seen in the
 * previous render of the same conversation are settled; a switched (or first)
 * conversation settles everything, so history never animates.
 */
export function useFreshMessageIds(
  messages: readonly { id: string }[],
  conversationId: string | null,
): ReadonlySet<string> {
  const seenIds = useRef<Set<string>>(new Set());
  const seenConversation = useRef<string | null>(null);
  const fresh = useMemo(() => {
    if (seenConversation.current !== conversationId) return new Set<string>();
    return new Set(messages.filter((m) => !seenIds.current.has(m.id)).map((m) => m.id));
  }, [messages, conversationId]);
  useEffect(() => {
    seenIds.current = new Set(messages.map((m) => m.id));
    seenConversation.current = conversationId;
  }, [messages, conversationId]);
  return fresh;
}
