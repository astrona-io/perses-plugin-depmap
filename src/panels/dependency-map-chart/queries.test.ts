import { parseDuration, seriesToSamples } from "./queries";

describe("parseDuration", () => {
  it.each([
    ["30d", 30 * 86400],
    ["1w2d", 9 * 86400],
    ["90m", 5400],
    ["1y", 365 * 86400],
    ["1.5h", 5400],
  ])("%s", (text, seconds) => expect(parseDuration(text)).toBe(seconds));

  it.each(["", "30", "d", "30x", "1d 2h", "-1d", "0s"])("rejects %p", (text) =>
    expect(parseDuration(text)).toBeUndefined(),
  );
});

describe("seriesToSamples", () => {
  it("reads OBI flows: bytes, server port, name", () => {
    const [s] = seriesToSamples(
      [
        {
          metric: {
            src_address: "10.0.0.1",
            dst_address: "10.0.0.2",
            server_port: "5432",
            dst_name: "db",
          },
          values: [
            [3600, "100"],
            [7200, "0"],
            [10800, "50"],
          ],
        },
      ],
      true,
    );
    expect(s).toEqual({
      src: "10.0.0.1",
      dst: "10.0.0.2",
      port: 5432,
      srcProcess: undefined,
      dstName: "db",
      hours: [1, 3],
      bytes: 150,
      lastSeen: 10800,
    });
  });

  it("reads the fallback script, swapping caller and callee on inbound connections", () => {
    const out = seriesToSamples(
      [
        {
          metric: {
            src_ip: "10.0.0.1",
            dst_ip: "10.0.0.2",
            dst_port: "443",
            src_process: "curl",
            direction: "out",
          },
          values: [[3600, "1"]],
        },
        {
          metric: {
            src_ip: "10.0.0.2",
            dst_ip: "10.0.0.9",
            dst_port: "443",
            src_process: "nginx",
            direction: "in",
          },
          values: [[3600, "1"]],
        },
      ],
      false,
    );
    expect(
      out.map((s) => [s.src, s.dst, s.port, s.srcProcess, s.bytes]),
    ).toEqual([
      ["10.0.0.1", "10.0.0.2", 443, "curl", undefined],
      ["10.0.0.9", "10.0.0.2", 443, undefined, undefined],
    ]);
  });

  it("skips series without addresses, port, or any sighting", () => {
    expect(
      seriesToSamples(
        [
          { metric: { dst_ip: "10.0.0.2", dst_port: "1" }, values: [[0, "1"]] },
          {
            metric: { src_ip: "10.0.0.1", dst_ip: "10.0.0.2" },
            values: [[0, "1"]],
          },
          {
            metric: { src_ip: "10.0.0.1", dst_ip: "10.0.0.2", dst_port: "1" },
            values: [[0, "0"]],
          },
          {
            metric: { src_ip: "10.0.0.1", dst_ip: "10.0.0.2", dst_port: "1" },
            values: [[0, "NaN"]],
          },
        ],
        false,
      ),
    ).toEqual([]);
  });
});

describe("seriesToSamples: Kubernetes decoration", () => {
  it("reads OBI's k8s_* labels per side, and the named ranges", () => {
    const [s] = seriesToSamples(
      [
        {
          metric: {
            src_address: "10.244.1.4",
            dst_address: "10.1.2.10",
            server_port: "1521",
            src_cidr: "pods",
            dst_cidr: "olddc",
            k8s_cluster_name: "example-cluster",
            k8s_src_type: "Pod",
            k8s_src_namespace: "shop",
            k8s_src_name: "orders-7d9f-a",
            k8s_src_owner_name: "orders",
            k8s_src_owner_type: "Deployment",
            k8s_src_node_name: "worker",
            k8s_src_node_ip: "10.89.0.16",
          },
          values: [[3600, "10"]],
        },
      ],
      true,
    );
    expect(s!.srcK8s).toEqual({
      type: "Pod",
      cluster: "example-cluster",
      namespace: "shop",
      name: "orders-7d9f-a",
      owner: "orders",
      ownerType: "Deployment",
      node: "worker",
      nodeIp: "10.89.0.16",
    });
    expect(s!.dstK8s).toBeUndefined();
    expect(s!.srcCidr).toBe("pods");
    expect(s!.dstCidr).toBe("olddc");
  });

  it("a node side has a type and a name and nothing else", () => {
    const [s] = seriesToSamples(
      [
        {
          metric: {
            src_address: "10.1.8.11",
            dst_address: "10.1.2.10",
            server_port: "1521",
            k8s_src_type: "Node",
            k8s_src_name: "worker",
            k8s_src_owner_name: "worker",
            k8s_src_owner_type: "Node",
            k8s_dst_type: "",
          },
          values: [[3600, "10"]],
        },
      ],
      true,
    );
    expect(s!.srcK8s).toEqual({
      type: "Node",
      name: "worker",
      owner: "worker",
      ownerType: "Node",
    });
    expect(s!.dstK8s).toBeUndefined();
  });
});
