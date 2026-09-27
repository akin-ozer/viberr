import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  retractWaitingMessage,
  sendQueuedMessageNow,
  type ControllerTurnInput,
  type SendMode,
} from "~/server/controller/controller-run.server";
import type { WaitingActionResult } from "./waiting-actions";

/** A text field at the request boundary: a string, trimmed; anything else
 *  (absent, a File part) reads as empty. */
const textField = z.string().catch("");

/** Ruling 527: the send mode a form posts. Only an explicit `queue` queues:
 *  steering is what a message sent while a turn works does by default. */
export function sendModeOf(formData: FormData): SendMode {
  return textField.parse(formData.get("mode")) === "queue" ? "queue" : "steer";
}

/**
 * Ruling 527: the Send now and Retract intents, one handler for the three
 * controller doors (the two pages and the dock's resource). Null for any other
 * intent. The engine decides: only the conversation's owner, and only a
 * message still waiting. Its refusals throw, for the door's own
 * `appErrorResponse`.
 */
export function waitingMessageAction(
  db: DatabaseSync,
  intent: string,
  formData: FormData,
  user: ControllerTurnInput["user"],
): WaitingActionResult | null {
  if (intent !== "send-now" && intent !== "retract") return null;
  const target = {
    conversationId: textField.parse(formData.get("conversationId")).trim(),
    messageId: textField.parse(formData.get("messageId")).trim(),
    user,
  };
  if (intent === "retract") {
    return {
      ok: true,
      retracted: retractWaitingMessage(db, target),
      toast: "Taken back into your composer.",
    };
  }
  return {
    ok: true,
    toast:
      sendQueuedMessageNow(db, target) === "steering"
        ? "It goes into the running turn at its next step."
        : "The turn is finishing its answer, so this is answered next.",
  };
}
