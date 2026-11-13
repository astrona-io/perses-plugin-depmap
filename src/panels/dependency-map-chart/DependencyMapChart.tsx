import { PanelPlugin } from "@perses-dev/plugin-system";
import { DependencyMapChartComponent } from "./DependencyMapChartComponent";
import {
  DependencyMapChartOptions,
  DependencyMapChartProps,
  createInitialDependencyMapChartOptions,
} from "./dependency-map-chart-types";
import { DependencyMapChartSettingsEditor } from "./DependencyMapChartSettingsEditor";

/**
 * Dependency map of the servers and services in a data centre, from network flows (OBI) or a fallback
 * connection script, both read through the Prometheus datasource. Built for planning a move to a new
 * data centre: waves as lanes, how often each edge is used, what breaks when servers go down, and the
 * firewall rules each wave needs.
 *
 * The panel runs its own range queries (one-hour steps over a long window) instead of taking the
 * panel's queries: it needs the hour-by-hour history of every edge, not one value per series.
 */
export const DependencyMapChart: PanelPlugin<
  DependencyMapChartOptions,
  DependencyMapChartProps
> = {
  PanelComponent: DependencyMapChartComponent,
  panelOptionsEditorComponents: [
    { label: "Settings", content: DependencyMapChartSettingsEditor },
  ],
  hideQueryEditor: true,
  createInitialOptions: createInitialDependencyMapChartOptions,
};
