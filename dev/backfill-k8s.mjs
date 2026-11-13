// History for the Kubernetes half of the example estate, written into Prometheus by dev/hybrid.sh.
// Synthetic, but with the label sets OBI v1.0.0 really reports on these nodes (checked
// against its /metrics in dev/): the pods, Services and nodes that exist now, the node addresses in the
// old data centre, and what OBI on each node would have counted.
//
//   kubectl get pods,services,nodes -A -o json | node dev/backfill-k8s.mjs <days> <obi-days> > out.om
//
// The story it tells: the cluster has run for <days>; OBI went on the nodes <obi-days> ago. Before
// that, only the database server's fallback script saw the nodes connect (SNATed pod traffic, pod
// unknown); since then OBI sees both sides and the panel stitches them into one path.
//
// One sample every 15 minutes, counters growing at a steady rate. History ends two hours before now
// so it never overlaps the live scrapes, which carry the same labels.
import { readFileSync } from "node:fs";

const [days, obiDays] = process.argv.slice(2).map(Number);
if (!(days > 0) || !(obiDays > 0) || obiDays > days) {
  console.error("usage: node backfill-k8s.mjs <days> <obi-days> < kubectl-get.json");
  process.exit(2);
}
const CLUSTER = "example-cluster";
const OLD_DC = { "control-plane": "10.1.8.10", worker: "10.1.8.11", worker2: "10.1.8.12" };
const ORACLE_VIP = "10.1.2.10";
const BANK = "198.51.100.43";
const BILLING = "10.1.1.13";
// Places of the estate view (dev/estate/mapping.yaml `places`): a load balancer in front of the
// cluster, a Ceph cluster the nodes mount volumes from, and two internet providers the pods call.
const EDGE_LB = "10.1.9.10";
const CEPH = ["10.1.5.1", "10.1.5.2"];
const PROVIDERS = [["140.82.112.3", 443], ["104.16.132.229", 443]];

const items = JSON.parse(readFileSync(0, "utf8")).items;
const nodes = items
  .filter((i) => i.kind === "Node")
  .map((n) => {
    const name = n.metadata.name;
    const role = name.replace(/^perses-plugin-depmap-/, "");
    const internal = n.status.addresses.find((a) => a.type === "InternalIP").address;
    return { name, internal, olddc: OLD_DC[role] };
  });
const node = (name) => nodes.find((n) => n.name === name);
const pods = items
  .filter((i) => i.kind === "Pod" && i.metadata.namespace === "shop" && i.status.podIP)
  .map((p) => ({
    name: p.metadata.name,
    ip: p.status.podIP,
    owner: p.metadata.labels.app,
    node: node(p.spec.nodeName),
  }));
const pricingSvc = items.find(
  (i) => i.kind === "Service" && i.metadata.namespace === "shop" && i.metadata.name === "pricing",
);
if (nodes.some((n) => !n.olddc) || !pricingSvc || pods.length < 4) {
  console.error("backfill-k8s: expected three nodes, the pricing Service and four shop pods");
  process.exit(1);
}

const cidr = (ip) =>
  ip.startsWith("10.244.") ? "pods" : ip.startsWith("10.96.") ? "services"
    : ip.startsWith("10.1.") ? "old-dc" : /^(198\.51\.100|140\.82|104\.16)\./.test(ip) ? "internet" : "";
const podSide = (side, p) => ({
  [`k8s_${side}_type`]: "Pod",
  [`k8s_${side}_namespace`]: "shop",
  [`k8s_${side}_name`]: p.name,
  [`k8s_${side}_owner_name`]: p.owner,
  [`k8s_${side}_owner_type`]: "Deployment",
  [`k8s_${side}_node_name`]: p.node.name,
  [`k8s_${side}_node_ip`]: p.node.internal,
});
const nodeSide = (side, n) => ({
  [`k8s_${side}_type`]: "Node",
  [`k8s_${side}_name`]: n.name,
  [`k8s_${side}_owner_name`]: n.name,
  [`k8s_${side}_owner_type`]: "Node",
});
const svcSide = (side, name) => ({
  [`k8s_${side}_type`]: "Service",
  [`k8s_${side}_namespace`]: "shop",
  [`k8s_${side}_name`]: name,
  [`k8s_${side}_owner_name`]: name,
  [`k8s_${side}_owner_type`]: "Service",
});

/** One OBI series as the OBI on node `on` reports it; bytes per hour. */
const flows = [];
function obi(on, src, dst, port, dstName, extra, bytesPerHour) {
  flows.push({
    metric: "obi_network_flow_bytes_total",
    obi: true,
    bytesPerHour,
    labels: {
      direction: "request",
      src_address: src,
      dst_address: dst,
      server_port: String(port),
      dst_name: dstName,
      src_cidr: cidr(src),
      dst_cidr: cidr(dst),
      obi_ip: on.internal,
      k8s_cluster_name: CLUSTER,
      ...extra,
      job: "obi",
      instance: `${on.olddc}:9400`,
    },
  });
}

const orders = pods.filter((p) => p.owner === "orders");
const pricing = pods.filter((p) => p.owner === "pricing");
const worker2 = node("perses-plugin-depmap-worker2");
for (const p of orders) {
  const on = p.node;
  obi(on, p.ip, pricingSvc.spec.clusterIP, 80, "pricing", { ...podSide("src", p), ...svcSide("dst", "pricing") }, 2600);
  for (const q of pricing)
    obi(on, p.ip, q.ip, 8080, q.name, { ...podSide("src", p), ...podSide("dst", q) }, 1300);
  for (const [dst, port] of [[ORACLE_VIP, 1521], [BANK, 443]]) {
    obi(on, p.ip, dst, port, dst, podSide("src", p), 5500);
    // The same connection after SNAT, leaving the node with its old-data-centre address.
    obi(on, on.olddc, dst, port, dst, nodeSide("src", on), 5500);
  }
  // kube-proxy forwarding NodePort traffic from worker2 (SNATed to the node): the panel drops it.
  obi(worker2, worker2.internal, p.ip, 8080, p.name, { ...nodeSide("src", worker2), ...podSide("dst", p) }, 900);
}
// Pods calling internet providers, with the pod as the source: OBI keeps the source decoration.
for (const p of pods)
  for (const [dst, port] of PROVIDERS) obi(p.node, p.ip, dst, port, dst, podSide("src", p), 800);
// Node kernels mounting Ceph volumes (RBD): monitors on 6789, OSDs on 6800-7300.
for (const n of nodes)
  for (const [i, host] of CEPH.entries()) {
    obi(n, n.olddc, host, 6789, host, nodeSide("src", n), 40);
    obi(n, n.olddc, host, 6800 + i, host, nodeSide("src", n), 90000);
  }
// The edge load balancer forwarding to the orders NodePort; its own host runs no collector.
for (const n of nodes.filter((x) => x.name !== "perses-plugin-depmap-control-plane"))
  obi(n, EDGE_LB, n.olddc, 30080, n.name, nodeSide("dst", n), 12000);
// billing (VM) -> the orders NodePort on worker2, as OBI on worker2 sees it.
obi(worker2, BILLING, worker2.olddc, 30080, worker2.name, nodeSide("dst", worker2), 1800);

// Before OBI: what the fallback script on the database server saw (inbound, so caller and callee
// swapped as the script writes them). Gauge 1 per hour, like dev/backfill.sh.
for (const n of nodes.filter((x) => x.name !== "perses-plugin-depmap-control-plane"))
  flows.push({
    metric: "depmap_connection_seen",
    obi: false,
    labels: {
      direction: "in",
      src_host: "db01",
      src_ip: ORACLE_VIP,
      src_process: "tnslsnr",
      dst_ip: n.olddc,
      dst_port: "1521",
      job: "node",
      instance: "node-exporter:9100",
    },
  });

const nowHour = Math.floor(Date.now() / 3600000);
const end = nowHour - 2;
const start = end - days * 24 + 1;
const obiStart = end - obiDays * 24 + 1;
const esc = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const fmt = (labels) =>
  `{${Object.entries(labels)
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(",")}}`;

const out = [];
for (const metric of ["obi_network_flow_bytes_total", "depmap_connection_seen"]) {
  const name = metric.replace(/_total$/, "");
  out.push(
    metric.startsWith("obi")
      ? `# TYPE ${name} counter`
      : `# TYPE ${name} gauge`,
  );
  for (const f of flows.filter((x) => x.metric === metric)) {
    const l = fmt(f.labels);
    if (f.obi) {
      let v = 0;
      for (let h = obiStart; h <= end; h++)
        for (let q = 0; q < 4; q++) {
          v += f.bytesPerHour / 4;
          out.push(`${metric}${l} ${v} ${h * 3600 + q * 900}`);
        }
    } else {
      for (let h = start; h < obiStart; h++) out.push(`${metric}${l} 1 ${h * 3600 + 1800}`);
    }
  }
}
out.push("# EOF");
process.stdout.write(out.join("\n") + "\n");
console.error(
  `backfill-k8s: ${flows.length} series, OBI from ${new Date(obiStart * 3600000).toISOString()}, ` +
    `fallback from ${new Date(start * 3600000).toISOString()}, until ${new Date((end + 1) * 3600000).toISOString()}`,
);
