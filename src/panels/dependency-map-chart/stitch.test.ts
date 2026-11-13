import {
  HOURS,
  ORDERS_A,
  ORDERS_B,
  hybridMapping,
  hybridSamples,
  node,
  sample,
} from "../../test-utils/hybrid";
import { buildInventory } from "./resolve";
import { stitch } from "./stitch";
import { EdgeSample } from "./model";

function run(samples: EdgeSample[]) {
  const mapping = hybridMapping();
  return stitch(mapping, buildInventory(mapping, samples), samples);
}

const kinds = (r: ReturnType<typeof run>): string[] =>
  r.samples.map((s) => `${s.src.kind}>${s.dst.kind}:${s.sample.port}`);

describe("stitch", () => {
  it("the hybrid estate: what is kept, folded and dropped", () => {
    const r = run(hybridSamples());
    expect(r.stats).toEqual({
      snatMatched: 1,
      snatUnknown: 1,
      serviceFolded: 1,
      nodeToPod: 2,
      plumbing: 2,
    });
    expect(kinds(r)).toEqual([
      "other>nodeport:30080",
      "other>nodeport:30080",
      "pod>pod:8080",
      "pod>pod:8080",
      "pod>other:1521",
      "nat>other:1521",
    ]);
  });

  it("egress SNAT: the node-side flow is matched to the pod on that node, same destination and hours", () => {
    const r = run([
      sample("10.244.1.4", "10.1.2.10", 1521, { src: ORDERS_A }),
      sample("10.1.8.11", "10.1.2.10", 1521, { src: node("worker") }),
    ]);
    expect(r.stats.snatMatched).toBe(1);
    expect(kinds(r)).toEqual(["pod>other:1521"]);
  });

  it("egress SNAT: a pod on another node does not explain it", () => {
    const r = run([
      sample("10.244.3.4", "10.1.2.10", 1521, { src: ORDERS_B }),
      sample("10.1.8.11", "10.1.2.10", 1521),
    ]);
    expect(kinds(r)).toEqual(["pod>other:1521", "nat>other:1521"]);
    expect(r.samples[1]!.src).toEqual({
      kind: "nat",
      cluster: "example-cluster",
      node: "worker",
    });
  });

  it("egress SNAT: another port or destination does not explain it", () => {
    const r = run([
      sample("10.244.1.4", "10.1.2.10", 1521, { src: ORDERS_A }),
      sample("10.1.8.11", "10.1.2.10", 1522),
      sample("10.1.8.11", "10.1.2.11", 1521),
    ]);
    expect(r.stats.snatUnknown).toBe(2);
  });

  it("egress SNAT: only the hours no pod-side flow covers stay, with their share of the bytes", () => {
    const r = run([
      sample(
        "10.244.1.4",
        "10.1.2.10",
        1521,
        { src: ORDERS_A },
        HOURS.slice(0, 12),
      ),
      sample("10.1.8.11", "10.1.2.10", 1521, {}, HOURS, 2400),
    ]);
    const nat = r.samples.find((s) => s.src.kind === "nat")!;
    expect(nat.sample.hours).toEqual(HOURS.slice(12));
    expect(nat.sample.bytes).toBe(1200);
    expect(r.stats).toMatchObject({ snatMatched: 1, snatUnknown: 1 });
  });

  it("egress SNAT: a pod with no node reported may be on any node", () => {
    const nodeless = { ...ORDERS_A, node: undefined, nodeIp: undefined };
    const r = run([
      sample("10.244.1.4", "10.1.2.10", 1521, { src: nodeless }),
      sample("10.1.8.12", "10.1.2.10", 1521),
    ]);
    expect(kinds(r)).toEqual(["pod>other:1521"]);
  });

  it("ClusterIP: a Service sample stays when no pod-side flow from that caller explains it", () => {
    const r = run([
      sample("10.244.1.4", "10.96.96.223", 80, {
        src: ORDERS_A,
        dst: {
          type: "Service",
          cluster: "example-cluster",
          namespace: "shop",
          name: "pricing",
        },
      }),
    ]);
    expect(kinds(r)).toEqual(["pod>service:80"]);
  });

  it("node to node and pod to its node are plumbing; node to pod is kube-proxy or kubelet", () => {
    const r = run([
      sample("10.1.8.10", "10.1.8.11", 10250),
      sample("10.244.1.4", "10.1.8.11", 10250, { src: ORDERS_A }),
      sample("10.1.8.11", "10.244.3.4", 8080, { dst: ORDERS_B }),
    ]);
    expect(r.samples).toEqual([]);
    expect(r.stats).toMatchObject({ plumbing: 2, nodeToPod: 1 });
  });

  it("VM-only estates pass through untouched", () => {
    const s = [sample("10.1.1.13", "10.1.2.10", 1521)];
    const r = run(s);
    expect(r.samples.map((x) => x.sample)).toEqual(s);
    expect(kinds(r)).toEqual(["other>other:1521"]);
  });
});
