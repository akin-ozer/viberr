/**
 * Ruling 503: where an epic's pages are. One spelling for the Epics pages, the
 * board's and the task page's chips, and the notices that open an epic
 * (`epicLink`), so a renamed route moves every door at once.
 */
export function epicsHref(projectSlug: string): string {
  return `/projects/${projectSlug}/epics`;
}

export function epicHref(projectSlug: string, epicId: string): string {
  return `${epicsHref(projectSlug)}/${epicId}`;
}
