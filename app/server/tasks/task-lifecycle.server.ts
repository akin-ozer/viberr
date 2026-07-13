/** Exact canonical task ownership carried across asynchronous work. */
export interface TaskLifecycleGuard {
  expectedCreatedAt: string;
  /** Project archive/delete aborts the shared incarnation signal. */
  signal?: AbortSignal;
}

/**
 * Fail closed at the mutation boundary. Checking this inside a locked task-file
 * callback is what prevents delayed work for task A from mutating a same-key
 * replacement task B while it was queued for the file lock.
 */
export function assertTaskLifecycleActive(
  guard: TaskLifecycleGuard | undefined,
  currentCreatedAt: string | null | undefined,
): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    throw new DOMException("Project lifecycle ownership was revoked.", "AbortError");
  }
  if (!currentCreatedAt || currentCreatedAt !== guard.expectedCreatedAt) {
    throw new DOMException("Task lifecycle ownership changed.", "AbortError");
  }
}
