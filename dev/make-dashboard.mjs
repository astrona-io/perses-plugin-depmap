// Writes dev/dashboards/depmap.json with dev/estate/mapping.yaml embedded in the panel's options.
// Run after changing the mapping: node dev/make-dashboard.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mapping = readFileSync(join(here, "estate/mapping.yaml"), "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("#"))
  .join("\n")
  .trim();

const dashboard = {
  kind: "Dashboard",
  metadata: { name: "dependency-map", project: "demo" },
  spec: {
    display: { name: "Dependency map: old data centre and Kubernetes" },
    duration: "30d",
    variables: [],
    panels: {
      depmap: {
        kind: "Panel",
        spec: {
          display: {
            name: "Who talks to whom",
            description:
              "Connections seen over the last 30 days. Estate: clusters, machines, namespaces and places (load balancer, storage, LAN, internet); click any box to open it, any workload for its dependencies. Lanes: the servers by migration wave, with firewall rules; What if takes servers or nodes down.",
          },
          plugin: {
            kind: "DependencyMapChart",
            spec: {
              datasource: { kind: "PrometheusDatasource" },
              window: "30d",
              mapping,
              lanes: {
                waveLabels: { 1: "Wave 1 (March)", 2: "Wave 2 (May)", 3: "Wave 3 (Sept)" },
                stayLabel: "Stays",
                externalLabel: "Outside",
              },
              scenarios: [
                { name: "LDAP split", down: ["ldap01", "ldap02"] },
                { name: "Primary DB lost", down: ["db01"] },
                { name: "One portal node", down: ["app01"] },
                { name: "NFS lost", down: ["nfs01"] },
                { name: "Kubernetes node lost", down: ["perses-plugin-depmap-worker2"] },
              ],
              linkTemplates: {
                node: "https://cmdb.example.com/services/${service}",
              },
            },
          },
        },
      },
    },
    layouts: [
      {
        kind: "Grid",
        spec: {
          items: [
            { x: 0, y: 0, width: 24, height: 17, content: { $ref: "#/spec/panels/depmap" } },
          ],
        },
      },
    ],
  },
};

writeFileSync(join(here, "dashboards/depmap.json"), JSON.stringify(dashboard, null, 2) + "\n");
console.log("wrote dev/dashboards/depmap.json");
