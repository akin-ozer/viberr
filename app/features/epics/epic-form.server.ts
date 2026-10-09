import type { UpdateEpicInput } from "~/server/tasks/epic-actions.server";

/** The fields an epic's create or edit form carries (ruling 272). */
export type EpicFormFields = Omit<UpdateEpicInput, "projectSlug" | "epicId">;

/**
 * Read the Epics pages' form: a field the form does not carry is left out, so
 * an edit writes only what it names (the header's status select posts the
 * status alone); a blank lead or date clears it; a blank colour on a create
 * leaves the pick to the colour sequence.
 */
export function epicFormFields(formData: FormData): EpicFormFields {
  const fields: EpicFormFields = {};
  const text = (name: string): string | undefined =>
    formData.has(name) ? String(formData.get(name) ?? "") : undefined;
  const title = text("title");
  if (title !== undefined) fields.title = title;
  const description = text("description");
  if (description !== undefined) fields.description = description;
  const status = text("status");
  if (status !== undefined) fields.status = status;
  const color = text("color");
  if (color !== undefined && color !== "") fields.color = color;
  const lead = text("leadUserId");
  if (lead !== undefined) fields.leadUserId = lead.trim() || null;
  const start = text("startDate");
  if (start !== undefined) fields.startDate = start.trim() || null;
  const target = text("targetDate");
  if (target !== undefined) fields.targetDate = target.trim() || null;
  return fields;
}
