/** The slice of a JSON Schema node the strictness walk below reads. Both
 *  Codex schemas are frozen `as const` literals, hence the readonly members. */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
}

/**
 * OpenAI strict structured-output invariant (the `codex_output_schema` rule
 * that failed every Codex agent run): every object node sets
 * `additionalProperties: false` AND lists EVERY property key in `required`.
 * Walks recursively, so a nested object's violation is caught too. Returns
 * one line per violation; an empty list is a schema the API accepts.
 *
 * Shared by the agent envelope and the operator plan, whose options nest
 * `newTask` (ruling 132): a violation in either fails
 * every Codex run that carries it.
 */
export function assertStrictSchema(node: JsonSchemaNode, path = "$"): string[] {
  const errs: string[] = [];
  const types = [node.type].flat();
  if (types.includes("object")) {
    const props = node.properties ?? {};
    const required = new Set(node.required ?? []);
    if (node.additionalProperties !== false) errs.push(`${path}: additionalProperties must be false`);
    for (const [key, child] of Object.entries(props)) {
      if (!required.has(key)) errs.push(`${path}.${key}: not in required`);
      errs.push(...assertStrictSchema(child, `${path}.${key}`));
    }
  }
  if (types.includes("array") && node.items) {
    errs.push(...assertStrictSchema(node.items, `${path}[]`));
  }
  return errs;
}
