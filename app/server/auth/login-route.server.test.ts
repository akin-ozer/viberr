import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

let app: AppTestContext;

beforeAll(async () => {
  app = await setupAppTest();
});

afterAll(() => app.cleanup());

describe("login OAuth error callback", () => {
  it("renders Better Auth's whitelist rejection through the normal login alert", async () => {
    const { loader } = await import("~/routes/login");
    const result = (await loader({
      request: app.request(
        "/login?error=unable_to_create_user&returnTo=%2Fprojects%2Fviberr-core%2Fboard",
      ),
      params: {},
      context: {},
    } as never)) as {
      data: {
        flash: { kind: "error"; message: string } | null;
        returnTo: string | null;
      };
    };

    expect(result.data.flash).toEqual({
      kind: "error",
      message:
        "This OAuth account isn't whitelisted for Viberr. Ask an admin to grant access, then try again.",
    });
    expect(result.data.returnTo).toBe("/projects/viberr-core/board");
  });
});
