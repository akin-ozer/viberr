/**
 * Store doctor: parse every canonical file and name the ones the app can no
 * longer trust — with the parse error and the offending line.
 *
 *   npm run store:check
 *
 * The store is designed to be hand-edited (FR10), so a malformed `task.md` is
 * an expected event. Parsing is deliberately tolerant, which is right for
 * reading — a broken file never crashes the app and never drops a task — but
 * it means nothing THREW, so `npm run rescan` reported `0 errors` over a file
 * whose fields had all fallen back to defaults, and the only remedy on offer
 * was "fix the file on disk" without saying which file.
 *
 * Read-only, database-free: no writer lock, safe on a live instance, and it
 * never rewrites a human's file.
 *
 * Exit code 1 when any file is untrusted, so it can gate a deploy or a cron.
 */
import { getEnv } from "../app/server/config/env.server";
import { checkStore } from "../app/server/files/store-check.server";

const env = getEnv();
const report = checkStore({ dataRoot: env.VIBERR_DATA_ROOT });

console.log(report.text);
if (report.untrusted.length > 0) process.exit(1);
