import { describe, expect, it } from "vitest";
import { capabilitiesToActionLabels } from "./agents-query.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";

const cap = (capabilityId: string, mode: CapabilityMode) => ({ capabilityId, mode });

/**
 * NEW-3: `human` (a structural always-human lock) and `off` (withheld from this
 * agent) are SEPARATE buckets. Conflating them made an explicitly withheld
 * capability render as "Reserved for humans" in the matrix / profile detail /
 * policy "N human" count, when it is simply not granted.
 */
describe("capabilitiesToActionLabels — off vs human separation (NEW-3)", () => {
  it("routes mode 'off' to the `off` bucket and mode 'human' to `forbidden`", () => {
    const out = capabilitiesToActionLabels(
      [
        cap("commit-push-branch", "direct"),
        cap("report-validation-verdict", "off"), // withheld → off, NOT reserved
        cap("merge-pull-request", "human"), // structural always-human → forbidden
      ],
      [],
    );
    expect(out.direct).toContain("Commit & push to the branch");
    // The withheld verdict is "not granted", NOT "reserved for humans".
    expect(out.off).toContain("Report a validation verdict");
    expect(out.forbidden).not.toContain("Report a validation verdict");
    // The genuine always-human lock stays in `forbidden` (renders "Reserved for humans").
    expect(out.forbidden).toContain("Merge a pull request");
    expect(out.off).not.toContain("Merge a pull request");
  });

  it("recommend stays its own bucket", () => {
    const out = capabilitiesToActionLabels([cap("stage-transitions", "recommend")], []);
    expect(out.recommend).toContain("Stage transitions");
    expect(out.off).toEqual([]);
  });
});
