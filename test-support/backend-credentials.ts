import type { DatabaseSync } from "node:sqlite";
import {
  disconnectBackend,
  setBackendApiKey,
} from "~/server/runtimes/backend-credentials.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * Connect / disconnect an agent backend for a test's person (ruling 121).
 *
 * Since ruling 121 there is no instance-level "the backend is available"
 * switch to flip — `setBackendAvailability` is gone. Whether a run may start is
 * a fact about the ONE person it bills, read from `user_backend_credentials`.
 * So a test that wants a run to reach its (fake) adapter connects the backend
 * for that run's principal: the task owner for a task run, the asker for a
 * controller turn.
 *
 * These go through the REAL store module — the same `setBackendApiKey` the
 * Profile route calls — so a test cannot end up with a row shape the product
 * would not produce. The only injected seam is the provider probe: the fake
 * `fetch` below answers 200 without leaving the process, because verifying a
 * synthetic key against api.anthropic.com is both impossible and forbidden
 * (`npm test` never touches the network).
 *
 * The secret is deliberately long and obviously synthetic: it is sealed with
 * the suite's own encryption key, it rides a fake run's spawn env, and the run
 * sink redacts it from persisted lines — so a test asserting redaction has a
 * value that clears the sink's minimum-length floor.
 */

/** Long enough to clear the sink's MIN_SECRET_VALUE_LEN, and unmistakable in a
 *  diff if one ever escapes into a fixture. */
const FAKE_SECRET = {
  claude: "sk-ant-viberr-test-fake-key-0000000000",
  codex: "sk-viberr-test-fake-platform-key-0000",
} as const satisfies Record<RealBackend, string>;

/** A `fetch` that accepts any key without a socket. The store only reads
 *  `response.ok` and `response.status`. */
function acceptingFetch(): typeof fetch {
  return async () => new Response("{}", { status: 200 });
}

/** The plaintext `connectFakeBackend` seals — what a run for this person
 *  carries in its spawn env, and what the sink must redact. */
export function fakeBackendSecret(backend: RealBackend): string {
  return FAKE_SECRET[backend];
}

export async function connectFakeBackend(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
): Promise<void> {
  await setBackendApiKey(
    db,
    { userId, label: `${userId}@test` },
    backend,
    "api_key",
    FAKE_SECRET[backend],
    { fetchImpl: acceptingFetch() },
  );
}

/** Connect BOTH backends for one person — the ordinary state of somebody who
 *  uses the product, and what most run-path tests want. */
export async function connectFakeBackends(
  db: DatabaseSync,
  userId: string,
): Promise<void> {
  await connectFakeBackend(db, userId, "claude");
  await connectFakeBackend(db, userId, "codex");
}

/**
 * Disconnect one backend for one person — the "not connected" half every
 * refusal test needs. Tolerates a person who never connected it, so a test can
 * state the posture it wants without first asking what the posture is.
 */
export async function disconnectFakeBackend(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
): Promise<void> {
  try {
    await disconnectBackend(db, { userId, label: `${userId}@test` }, backend);
  } catch {
    // Already disconnected: `disconnectBackend` refuses rather than lying, and
    // for a harness "make sure this is off" that refusal is the success case.
  }
}
