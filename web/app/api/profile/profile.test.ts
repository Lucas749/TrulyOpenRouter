import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getProfile, saveProfile } from "../../../lib/profiles";
import { GET as getRoute, POST as saveRoute } from "./route";

describe("profiles", () => {
  it("saves + loads display names, validates input", async () => {
    process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-profiles-"));
    delete process.env.DATABASE_URL;
    expect(await getProfile("0xAbC0000000000000000000000000000000000001")).toBeNull();
    const p = await saveProfile("0xAbC0000000000000000000000000000000000001", "  Sanne  ");
    expect(p).toMatchObject({ wallet: "0xabc0000000000000000000000000000000000001", displayName: "Sanne" });
    expect((await getProfile("0xabc0000000000000000000000000000000000001"))?.displayName).toBe("Sanne");
    expect(await getProfile("")).toBeNull();

    const badWallet = await saveRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ wallet: "nope", displayName: "x" }) }));
    expect(badWallet.status).toBe(400);
    const badName = await saveRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ wallet: "0xabc0000000000000000000000000000000000001", displayName: "  " }) }),
    );
    expect(badName.status).toBe(400);
    const ok: any = await (
      await saveRoute(
        new Request("http://x", { method: "POST", body: JSON.stringify({ wallet: "0xabc0000000000000000000000000000000000001", displayName: "Sanne K" }) }),
      )
    ).json();
    expect(ok.profile.displayName).toBe("Sanne K");
    const listed: any = await (await getRoute(new Request("http://x/api/profile?wallet=0xabc0000000000000000000000000000000000001"))).json();
    expect(listed.profile.displayName).toBe("Sanne K");
  });
});
