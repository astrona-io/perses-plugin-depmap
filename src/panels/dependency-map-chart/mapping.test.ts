import { readFileSync } from "fs";
import { join } from "path";
import { MAPPING_YAML } from "../../test-utils/estate";
import { isCidr, isIp, parseMapping, updateWaves } from "./mapping";

describe("parseMapping", () => {
  it("parses the example estate without errors", () => {
    const r = parseMapping(MAPPING_YAML);
    expect(r.errors).toEqual([]);
    expect(r.mapping.services).toHaveLength(12);
    expect(r.mapping.external).toHaveLength(2);
  });

  it("parses collect/mapping.example.yaml without errors", () => {
    const text = readFileSync(
      join(__dirname, "../../../collect/mapping.example.yaml"),
      "utf8",
    );
    const r = parseMapping(text);
    expect(r.errors).toEqual([]);
    expect(r.mapping.services.map((s) => s.id)).toEqual([
      "portal",
      "db",
      "ldap",
      "reports",
    ]);
  });

  it("accepts JSON and empty input", () => {
    expect(
      parseMapping(
        '{"services":[{"id":"a","instances":[{"host":"h","ip":"10.0.0.1"}]}]}',
      ).errors,
    ).toEqual([]);
    expect(parseMapping("")).toEqual({
      mapping: { services: [], external: [] },
      errors: [],
    });
    expect(parseMapping("# only a comment\n").errors).toEqual([]);
  });

  it("reports YAML syntax errors", () => {
    const r = parseMapping("services: [\n");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/^mapping: /);
  });

  it("reports every schema problem with its path and keeps what is valid", () => {
    const r = parseMapping(`
services:
  - id: a
    wave: -1
    ha: cluster
    vip: not-an-ip
    load: -5
    colour: red
    instances:
      - { host: h1, ip: 10.0.0.1, role: boss }
      - { host: h2 }
      - { host: h3, ip: 10.0.0.3 }
  - id: a
    instances: []
  - name: no id
  - id: b
    ha: active-passive
    minUp: 3
    instances:
      - { host: h3, ip: 10.0.0.9 }
      - { host: h4, ip: 10.0.0.3 }
  - id: c
    ha: active-passive
    instances:
      - { host: c1, ip: 10.0.2.1, role: primary }
      - { host: c2, ip: 10.0.2.2, role: primary }
external:
  - { name: nameless }
  - { match: 192.0.2.0/24, name: 7 }
extra: 1
`);
    expect(r.errors).toEqual([
      'mapping: unknown key "extra"',
      'services[0]: unknown key "colour"',
      "services[a].wave: must be an integer >= 0",
      "services[a].ha: must be one of single, active-active, active-passive, quorum",
      "services[a].vip: must be an IP address",
      "services[a].load: must be a number >= 0 (percent)",
      "services[a].instances[0].role: must be primary, standby or member",
      "services[a].instances[1].ip: required IP address",
      "services[a]: duplicate id",
      "services[2].id: required string",
      "services[b].instances[0].host: h3 is already in a",
      "services[b].instances[1].ip: 10.0.0.3 is already used by a",
      "services[b].minUp: 3 is more than its 0 instances",
      "services[b].ha: active-passive needs at least 2 instances",
      "services[c].instances: only one primary allowed",
      "external[0].match: required string (IP, CIDR or name)",
      "external[1].name: must be a string",
    ]);
    expect(r.mapping.services.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(r.mapping.services[0]!.instances.map((i) => i.host)).toEqual(["h3"]);
    expect(r.mapping.external).toEqual([{ match: "192.0.2.0/24" }]);
  });

  it("rejects a top level that is not an object", () => {
    expect(parseMapping("- a\n- b\n").errors).toEqual([
      "mapping: must be an object",
    ]);
  });
});

describe("updateWaves", () => {
  it("writes waves back and keeps comments", () => {
    const text =
      "# estate\nservices:\n  - id: a # the app\n    wave: 1\n    instances: []\n  - id: b\n    instances: []\n";
    const out = updateWaves(text, { a: 2, b: 3 });
    expect(out).toContain("# estate");
    expect(out).toContain("# the app");
    const r = parseMapping(out);
    expect(r.mapping.services.map((s) => s.wave)).toEqual([2, 3]);
  });

  it("leaves text without services alone", () => {
    expect(updateWaves("external: []\n", { a: 1 })).toBe("external: []\n");
  });
});

describe("isIp / isCidr", () => {
  it("validates", () => {
    expect(isIp("10.1.2.3")).toBe(true);
    expect(isIp("2001:db8::1")).toBe(true);
    expect(isIp("10.1.2.300")).toBe(false);
    expect(isIp("db01")).toBe(false);
    expect(isCidr("10.0.0.0/8")).toBe(true);
    expect(isCidr("10.0.0.0/33")).toBe(false);
    expect(isCidr("2001:db8::/32")).toBe(true);
    expect(isCidr("10.0.0.0")).toBe(false);
  });
});
