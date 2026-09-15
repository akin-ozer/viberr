import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";

/** What every Viberr MCP tool answers with, at the SDK's own definition of
 *  it, so this file never restates a contract it does not own. */
type ToolText = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/**
 * The SDK's `tool()` at the signature its MCP server actually honours.
 *
 * The published types take a raw Zod field map, which is the one thing a
 * STRICT object is not, and the reason unknown arguments are stripped. The
 * server it builds validates with whatever Zod schema it is handed. `Args` is
 * inferred from the handler, so a call site's own argument annotation is
 * still checked against the fields it declared.
 */
type WholeSchemaTool = <Args>(
  name: string,
  description: string,
  schema: z.ZodType,
  handler: (args: Args) => Promise<ToolText>,
) => SdkMcpToolDefinition;

// SAFETY: the same function, with one parameter widened from a field map to
// the schema that field map is turned into. Nothing about the runtime
// changes; what changes is which schemas TypeScript lets a caller pass. The
// behaviour this depends on -- that a whole strict object reaches validation
// and refuses unknown keys -- is proven in strict-tool.server.test.ts against
// a real MCP client and server rather than asserted here.
const wholeSchemaTool = sdkTool as WholeSchemaTool;

/**
 * Ruling 296: a tool argument Viberr does not know is a REFUSAL, not a silent
 * drop.
 *
 * A plain Zod object strips keys it does not declare, so an agent that
 * invents or misspells an argument gets its call run WITHOUT that argument
 * and an answer computed from what survived. The published JSON Schema
 * carries no `additionalProperties: false` either, so the model is never told
 * the key is invalid. Measured at the real MCP boundary before this existed:
 * `{ a: "x", status: "failed" }` reached the handler as `{ a: "x" }` and the
 * call returned success.
 *
 * The controller hit the read half live and reported it. It asked `list_runs`
 * for failed runs, `list_runs` has no `status` argument, and it got the LIVE
 * listing back as though that were the answer: "it returned a
 * plausible-looking wrong answer rather than refusing". The write half is
 * worse, because these same field maps back `update_task`,
 * `run_agent_on_task` and `accept_completion`, where a misspelled `duedate`
 * rides along beside a good `goal` and the tool answers "[done] updated:
 * goal." while the date it was also asked for was never written.
 *
 * A strict object refuses instead, names the key, and never reaches the
 * handler, so nothing is half-applied. Same posture as rulings 288 and 295
 * one layer down: refuse by name with nothing written.
 *
 * Nested objects are strict at their own call sites, with `z.strictObject`,
 * rather than being rebuilt by reflection here. Rebuilding drops the
 * `.describe()` text that IS the agent's instructions, and a rule you can
 * read in the field map beats one you have to know a wrapper applies. The
 * sweep in strict-tool.server.test.ts is what keeps them honest.
 */
export function strictTool<Fields extends Record<string, z.ZodType>>(
  name: string,
  description: string,
  fields: Fields,
  handler: (args: z.infer<z.ZodObject<Fields>>) => Promise<ToolText>,
): SdkMcpToolDefinition {
  return wholeSchemaTool(
    name,
    description,
    z.strictObject(fields),
    // Ruling 303: no tool hands the SDK a bare handler.
    guarded(name, handler),
  );
}

/**
 * Ruling 303: an unexpected failure answers in words, on every surface.
 *
 * Measured, live: four operator tool calls came back to a run as the literal
 * string `database is not open`, from `get_task` and `read_board`, in the six
 * seconds before this instance's old process finished shutting down. The
 * database had closed under a run that was still calling tools.
 *
 * The leak is the finding, not the shutdown. Every one of the operator's 17
 * tools passed its handler to the SDK bare, so ANY throw inside became the
 * model's answer verbatim -- a SQLite sentence, a stack's message, whatever it
 * was. Its two siblings both convert: the controller's `run`/`runWith` guards
 * turn an unknown error into "[error] That action failed unexpectedly", and
 * the agent toolkit catches per tool ("[error] The board could not be read.").
 * The operator, the actor that relays what it reads onto a human's timeline,
 * was the one that did not.
 *
 * So the conversion lives here, where every Viberr tool on every surface
 * already passes and a new one cannot opt out. An `AppError` keeps its own
 * words, because those are written for the caller. Anything else is logged
 * with the tool's name and answered with a sentence that says what is true:
 * this call produced no answer, so do not report one.
 */
function guarded(
  name: string,
  handler: (args: never) => Promise<ToolText>,
): (args: never) => Promise<ToolText> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof AppError) {
        return { content: [{ type: "text", text: `[error] ${error.userMessage}` }] };
      }
      logger.error("mcp tool failed", {
        tool: name,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      return {
        content: [
          {
            type: "text",
            text:
              `[error] \`${name}\` failed unexpectedly and returned no answer. The details are ` +
              "in the server log. Do not report anything as a fact about this call: you did " +
              "not get a result, which is different from getting an empty one.",
          },
        ],
      };
    }
  };
}
