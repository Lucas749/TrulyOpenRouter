import { describe, expect, it } from "vitest";
import { apiError } from "./api-error";

describe("apiError", () => {
  it("unwraps both error shapes, never [object Object]", () => {
    expect(apiError({ error: "plain" }, 400)).toBe("plain");
    expect(apiError({ error: { message: "nested" } }, 400)).toBe("nested");
    expect(apiError({}, 404)).toBe("404");
    expect(apiError(null, 502)).toBe("502");
  });
});
