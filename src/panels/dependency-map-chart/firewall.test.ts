import { estateModel } from "../../test-utils/estate";
import {
  firewallRulesForWave,
  formatRule,
  formatRules,
  wavesOf,
  zoneOf,
} from "./firewall";

describe("firewall rules per wave", () => {
  const m = estateModel();
  const lines = (wave: number): string[] =>
    firewallRulesForWave(m, wave).map(formatRule);

  it("knows the waves", () => {
    expect(wavesOf(m)).toEqual([1, 2, 3]);
  });

  it("zones: moved waves are new, later waves and wave 0 stay old, the rest is outside", () => {
    expect(zoneOf(m.byId.get("portal")!, 1)).toBe("new");
    expect(zoneOf(m.byId.get("billing")!, 1)).toBe("old");
    expect(zoneOf(m.byId.get("billing")!, 2)).toBe("new");
    expect(zoneOf(m.byId.get("ldap")!, 3)).toBe("old");
    expect(zoneOf(m.byId.get("ext:bank-api.example.com")!, 1)).toBe("ext");
  });

  it("wave 1: only edges that cross out of the new DC, per instance, hard-wired callers to their member only", () => {
    expect(lines(1)).toEqual([
      "app01 (10.1.1.11) -> app03 (10.1.1.13):8443/tcp",
      "app04 (10.1.1.14) -> app03 (10.1.1.13):8443/tcp",
      "app01 (10.1.1.11) -> ldap01 (10.1.4.1):636/tcp",
      "app04 (10.1.1.14) -> ldap01 (10.1.4.1):636/tcp",
      "app01 (10.1.1.11) -> nfs01 (10.1.4.10):2049/tcp",
      "app04 (10.1.1.14) -> nfs01 (10.1.4.10):2049/tcp",
    ]);
  });

  it("wave 2: VIP callers get every member plus the VIP; a pinned caller only its member", () => {
    const l = lines(2);
    expect(l).toEqual(
      expect.arrayContaining([
        "app03 (10.1.1.13) -> db01 (10.1.2.1):1521/tcp",
        "app03 (10.1.1.13) -> db02 (10.1.2.2):1521/tcp",
        "app03 (10.1.1.13) -> oracle vip (10.1.2.10):1521/tcp",
        "win05 (10.1.1.25) -> db01 (10.1.2.1):1521/tcp",
        "app03 (10.1.1.13) -> bank-api.example.com (198.51.100.43):443/tcp",
        "batch01 (10.1.3.1) -> ftp.partner.example.com (198.51.100.21):21/tcp",
        "win05 (10.1.1.25) -> ldap02 (10.1.4.2):636/tcp",
      ]),
    );
    expect(l).not.toContain("win05 (10.1.1.25) -> db02 (10.1.2.2):1521/tcp");
    // portal -> billing is inside the new DC after wave 2.
    expect(l.some((x) => x.includes(":8443/"))).toBe(false);
    expect(l).toHaveLength(19);
    expect(new Set(l).size).toBe(l.length);
  });

  it("wave 3: oracle and the queue move; callers left behind need rules in", () => {
    const l = lines(3);
    expect(l).toEqual(
      expect.arrayContaining([
        "db01 (10.1.2.1) -> 10.1.7.22 (10.1.7.22):1521/tcp",
      ]),
    );
    // Everyone calling oracle moved already in waves 1-2: no rule for them.
    expect(l.some((x) => x.startsWith("app03"))).toBe(false);
    // The unknown address is called by both oracle members (an idle standby is configured like its sibling).
    expect(l).toContain("db02 (10.1.2.2) -> 10.1.7.22 (10.1.7.22):1521/tcp");
  });

  it("formats a copyable list", () => {
    expect(formatRules(firewallRulesForWave(m, 1)).split("\n")).toHaveLength(6);
    expect(firewallRulesForWave(m, 9)).toEqual([]);
  });
});
