import { estateModel } from "../../test-utils/estate";
import { DEFAULT_THRESHOLDS } from "./dependency-map-chart-types";
import { evaluateFailure, loseOneServer } from "./failure";
import { firewallRulesForWave } from "./firewall";
import { MAX_ROWS, NODE_W, laneSpecs, layoutGraph } from "./layout";
import { Mapping } from "./mapping";
import { EdgeSample, buildModel } from "./model";

const labels = {
  waveLabels: { "1": "Wave 1 (March)" },
  stayLabel: "Stays",
  externalLabel: "Outside",
};

describe("layout", () => {
  it("puts waves first, then what stays, then outside; no overlaps within a lane", () => {
    const m = estateModel();
    const lanes = laneSpecs(m.nodes, labels);
    expect(lanes.map((l) => l.label)).toEqual([
      "Wave 1 (March)",
      "Wave 2",
      "Wave 3",
      "Kubernetes · example-cluster",
      "Stays",
      "Outside",
    ]);
    const l = layoutGraph(m.nodes, m.edges, lanes);
    expect(l.nodes.size).toBe(m.nodes.length);
    expect(l.chips).toHaveLength(
      m.nodes.reduce((s, n) => s + n.instances.length, 0),
    );
    const placed = [...l.nodes.values()];
    for (const a of placed)
      for (const b of placed)
        if (a !== b && a.x === b.x)
          expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual((a.h + b.h) / 2);
    const xs = lanes.map((ln) => l.lanes.find((p) => p.key === ln.key)!.x0);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("splits a crowded lane into sub-columns", () => {
    const mapping: Mapping = {
      services: Array.from({ length: 30 }, (_, i) => ({
        id: `s${i}`,
        wave: 1,
        instances: [{ host: `h${i}`, ip: `10.0.0.${i + 1}` }],
      })),
      external: [],
    };
    const m = buildModel(mapping, [], DEFAULT_THRESHOLDS, 24);
    const l = layoutGraph(m.nodes, m.edges, laneSpecs(m.nodes, labels));
    const xs = new Set([...l.nodes.values()].map((p) => p.x));
    expect(xs.size).toBe(Math.ceil(30 / MAX_ROWS));
    expect(l.width).toBeGreaterThan(xs.size * NODE_W);
  });
});

describe("performance", () => {
  it("150 services and 600 edges: model, layout, failure, lose-one-server and firewall under a second", () => {
    const mapping: Mapping = {
      services: Array.from({ length: 150 }, (_, i) => ({
        id: `svc${i}`,
        wave: i % 4,
        ha: i % 5 === 0 ? ("active-passive" as const) : ("single" as const),
        vip: i % 5 === 0 ? `10.9.${i}.10` : undefined,
        instances:
          i % 5 === 0
            ? [
                { host: `h${i}a`, ip: `10.8.${i}.1`, role: "primary" as const },
                { host: `h${i}b`, ip: `10.8.${i}.2`, role: "standby" as const },
              ]
            : [{ host: `h${i}`, ip: `10.8.${i}.1` }],
      })),
      external: [],
    };
    // Deterministic pseudo-random edges, callers only to higher ids so the graph is a DAG plus noise.
    let seed = 42;
    const rnd = (): number =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const samples: EdgeSample[] = [];
    const pairs = new Set<string>();
    while (pairs.size < 600) {
      const a = Math.floor(rnd() * 149);
      const b = a + 1 + Math.floor(rnd() * (149 - a));
      if (pairs.has(`${a}-${b}`)) continue;
      pairs.add(`${a}-${b}`);
      const hours = Array.from({ length: 720 }, (_, h) => h).filter(
        () => rnd() < 0.5,
      );
      samples.push({
        src: `10.8.${a}.1`,
        dst: `10.8.${b}.1`,
        port: 1000 + b,
        hours,
        lastSeen: 720 * 3600,
      });
    }
    const t0 = performance.now();
    const m = buildModel(mapping, samples, DEFAULT_THRESHOLDS, 720);
    const l = layoutGraph(m.nodes, m.edges, laneSpecs(m.nodes, labels));
    evaluateFailure(m, ["h10a", "h20", "h33"]);
    for (const w of [1, 2, 3]) firewallRulesForWave(m, w);
    const tLayout = performance.now() - t0;
    loseOneServer(m);
    const tAll = performance.now() - t0;
    expect(m.nodes).toHaveLength(150);
    expect(m.edges).toHaveLength(600);
    expect(l.nodes.size).toBe(150);
    expect(tLayout).toBeLessThan(1000);
    expect(tAll).toBeLessThan(1000);
  });
});
