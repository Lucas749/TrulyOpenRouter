import { describe, expect, it } from "vitest";
import { approvalMessage, memberActionMessage, parseActionMessage, shortId, spendBarState } from "../lib/member-messages";

describe("canonical message formats (PINNED — drift breaks live signatures)", () => {
  it("memberActionMessage sorts fields and appends expiry", () => {
    expect(memberActionMessage("member-add", { orgId: "o1", did: "d1", wallet: "0xabc", role: "member" }, 123)).toBe(
      ["tor-team:member-add", "did: d1", "orgId: o1", "role: member", "wallet: 0xabc", "expires: 123"].join("\n"),
    );
  });

  it("parseActionMessage roundtrips and rejects junk", () => {
    const m = memberActionMessage("member-set", { orgId: "o1", did: "d1" }, 9);
    expect(parseActionMessage(m)).toEqual({ action: "member-set", fields: { orgId: "o1", did: "d1" }, expires: 9 });
    expect(parseActionMessage("hello")).toBeNull();
    expect(parseActionMessage("tor-team:x\nno-colon-here")).toBeNull();
    expect(parseActionMessage("tor-team:x\nfoo: bar")).toBeNull(); // missing expires
  });

  it("approvalMessage pins exact bytes", () => {
    expect(approvalMessage({ id: "req_1", orgId: "o1", memberDid: "d1", amountCredits: 400 }, "approve", 7)).toBe(
      [
        "TrulyOpenRouter allowance decision",
        "action: approve",
        "request: req_1",
        "org: o1",
        "member: d1",
        "newCap: 400",
        "expires: 7",
      ].join("\n"),
    );
  });
});

describe("spendBarState", () => {
  it("maps spend to design-token states", () => {
    expect(spendBarState(null, 100)).toMatchObject({ state: "none", label: "—" });
    expect(spendBarState(10, null)).toMatchObject({ state: "none" });
    expect(spendBarState(30, 100)).toMatchObject({ state: "ok", pct: 30 });
    expect(spendBarState(85, 100)).toMatchObject({ state: "warning", pct: 85 });
    expect(spendBarState(100, 100)).toMatchObject({ state: "capped", pct: 100 });
    expect(spendBarState(150, 100)).toMatchObject({ state: "capped", pct: 100 });
    expect(spendBarState(0, 0)).toMatchObject({ state: "capped" });
  });

  it("shortId truncates like the rest of the app", () => {
    expect(shortId("0x1234567890abcdef", 10)).toBe("0x12345678…");
    expect(shortId("abc", 10)).toBe("abc");
  });
});
