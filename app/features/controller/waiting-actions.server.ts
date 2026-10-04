import type { DatabaseSync } from "node:sqlite";
import { data, replace } from "react-router";
import { z } from "zod";
import type { SessionUser } from "~/server/auth/require-user.server";
import { createConversation } from "~/server/controller/controller-conversations.server";
import { deleteControllerConversation } from "~/server/controller/controller-deletion.server";
import {
  checkMessageFiles,
  interruptControllerTurn,
  retractWaitingMessage,
  runControllerTurn,
  sendQueuedMessageNow,
  type ControllerTurnInput,
  type SendMode,
} from "~/server/controller/controller-run.server";
import { formFiles } from "~/server/files/form-files.server";
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

/**
 * The action both Controller pages answer (ruling 99): `/controller` with
 * `projectSlug` null, `/projects/:slug/controller` with its slug. Send, Send
 * now and Retract, Interrupt and Delete; any other intent is refused. The
 * engine's refusals throw, for the page's own `appErrorResponse`.
 */
export async function controllerPageAction(
  db: DatabaseSync,
  intent: string,
  formData: FormData,
  user: SessionUser,
  projectSlug: string | null,
) {
  const asker = { id: user.id, email: user.email, name: user.name, orgRole: user.role };
  if (intent === "send") {
    const text = String(formData.get("text") ?? "");
    // Ruling 573: the files it carries, checked before a thread is made for
    // it, so a refused file leaves no empty conversation behind.
    const files = checkMessageFiles(await formFiles(formData));
    let conversationId = String(formData.get("conversationId") ?? "");
    if (!conversationId) {
      conversationId = createConversation(db, {
        userId: user.id,
        userLabel: user.email,
        projectSlug,
      }).id;
    }
    const result = await runControllerTurn(db, {
      conversationId,
      text,
      files,
      user: asker,
      // Ruling 121(d) records the page every USER message was sent from, and
      // that includes the ones sent from here (review finding 23). The store
      // normalizes it; a form without the field records null, as before.
      surface: String(formData.get("surface") ?? "") || null,
      // U39-24: the reader's zone; normalized by the engine.
      timeZone: String(formData.get("timeZone") ?? "") || null,
      // Ruling 527: steer the working turn (the default) or queue behind it.
      mode: sendModeOf(formData),
    });
    if (result.state === "refused") {
      // U35-4 (pass 35): the refusal is recorded IN the conversation (a
      // reload still shows it), and the door says so too: 409, never a 200
      // for a message nothing will answer.
      return data(
        { ok: false as const, error: result.reason, conversationId },
        { status: 409 },
      );
    }
    return { ok: true as const, conversationId };
  }
  // Ruling 527: Send now and Retract on a message still waiting.
  const waiting = waitingMessageAction(db, intent, formData, asker);
  if (waiting) return waiting;
  if (intent === "interrupt") {
    // The Live-run strip's Interrupt, confirmed on the page. The engine
    // decides who may stop a controller turn (its owner or an org admin) and
    // settles the turn so the transcript records that it was stopped.
    const result = await interruptControllerTurn(
      db,
      {
        conversationId: String(formData.get("conversationId") ?? ""),
        runId: String(formData.get("runId") ?? ""),
      },
      { userId: user.id, label: user.email },
    );
    return {
      ok: true as const,
      toast:
        result.outcome === "interrupted"
          ? "Turn interrupted. The transcript records that it was stopped."
          : "That turn had already ended.",
    };
  }
  if (intent === "delete-conversation") {
    // Ruling 525: the rail's Delete, confirmed on the page. The engine
    // decides who may (its starter, an org admin, or on a project's page a
    // holder of `delete-controller-conversations` there), stops a running
    // turn and purges what the turns logged. A project's page deletes only
    // its board's and its tasks' threads: another scope's id is not found.
    const conversationId = String(formData.get("conversationId") ?? "");
    deleteControllerConversation(
      db,
      { conversationId, projectSlug },
      { userId: user.id, label: user.email },
    );
    // The thread on screen is gone, and its URL would now answer 404: land
    // where a bare visit does (U33-8), in place of the entry that named it.
    if (String(formData.get("open") ?? "") === conversationId) {
      const page = projectSlug
        ? `/projects/${encodeURIComponent(projectSlug)}/controller`
        : "/controller";
      return replace(formData.get("all") === "1" ? `${page}?all=1` : page);
    }
    return { ok: true as const, toast: "Conversation deleted." };
  }
  return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
}
