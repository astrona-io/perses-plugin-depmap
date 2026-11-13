import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  estateModel,
  estateSamples,
  END_HOUR,
  WINDOW_HOURS,
} from "../../test-utils/estate";
import { DependencyMapChartComponent } from "./DependencyMapChartComponent";
import { DependencyMapView } from "./DependencyMapView";
import { Palette } from "./chart-option";
import {
  DependencyMapChartOptions,
  DependencyMapChartProps,
  resolveOptions,
  DEFAULT_THRESHOLDS,
} from "./dependency-map-chart-types";
import { DepmapData } from "./useDepmapData";
import { Mapping, parseMapping } from "./mapping";
import { EdgeSample, buildModel } from "./model";

// The canvas is replaced by a stub that exposes the option and lets tests click items.
let lastOption:
  | {
      series: Array<{
        data: Array<{ id: string; name?: string }>;
        links: unknown[];
      }>;
    }
  | undefined;
jest.mock("./GraphCanvas", () => ({
  GraphCanvas: (p: {
    option: object;
    onNodeClick: (id: string) => void;
    onEdgeClick: (id: string) => void;
  }) => {
    lastOption = p.option as typeof lastOption;
    return (
      <div data-testid="graph">
        <button onClick={() => p.onNodeClick("chip:oracle|db01")}>
          click chip db01
        </button>
        <button onClick={() => p.onNodeClick("portal")}>click portal</button>
      </div>
    );
  },
}));

let mockData: DepmapData = { windowHours: 720, endSeconds: 0, isLoading: true };
jest.mock("./useDepmapData", () => ({ useDepmapData: () => mockData }));
jest.mock("@perses-dev/components", () => ({
  LoadingOverlay: () => <div role="progressbar">loading</div>,
  useChartsTheme: () => ({ echartsTheme: {} }),
}));

const palette: Palette = {
  text: "#111",
  textSecondary: "#555",
  divider: "#ddd",
  paper: "#fff",
  background: "#fafafa",
  error: "#d32f2f",
  warning: "#ed6c02",
  primary: "#1976d2",
  secondary: "#9c27b0",
  info: "#0288d1",
  success: "#2e7d32",
  alpha: (c, a) => `${c}/${a}`,
};

const mappingText = readFileSync(
  join(__dirname, "../../../dev/estate/mapping.yaml"),
  "utf8",
);
const dims = { width: 1200, height: 700 };

function renderComponent(spec: DependencyMapChartOptions): void {
  render(
    <DependencyMapChartComponent
      {...({
        spec: { defaultView: "lanes", ...spec },
        contentDimensions: dims,
      } as unknown as DependencyMapChartProps)}
    />,
  );
}

describe("DependencyMapChartComponent", () => {
  beforeEach(() => {
    lastOption = undefined;
  });

  it("shows the loading overlay first", () => {
    mockData = { windowHours: 720, endSeconds: 0, isLoading: true };
    renderComponent({ mapping: mappingText });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("says plainly when nothing was seen", () => {
    mockData = {
      windowHours: 720,
      endSeconds: 0,
      isLoading: false,
      results: {
        samples: [],
        volume: [],
        loads: {},
        sources: { obi: false, fallback: false },
      },
    };
    renderComponent({ mapping: mappingText });
    expect(
      screen.getByText(/No connections seen in the window/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("graph")).toBeNull();
  });

  it("shows query errors", () => {
    mockData = {
      windowHours: 720,
      endSeconds: 0,
      isLoading: false,
      error: new Error("bad_data: parse error"),
    };
    renderComponent({ mapping: mappingText });
    expect(screen.getByText("bad_data: parse error")).toBeInTheDocument();
  });

  it("shows a mapping that cannot be read", () => {
    mockData = {
      windowHours: 720,
      endSeconds: 0,
      isLoading: false,
      results: {
        samples: [],
        volume: [],
        loads: {},
        sources: { obi: false, fallback: false },
      },
    };
    renderComponent({ mapping: "services: [ {id: " });
    expect(
      screen.getByText(/The mapping could not be read/),
    ).toBeInTheDocument();
  });

  it("draws the estate from the fixture", () => {
    mockData = {
      windowHours: WINDOW_HOURS,
      endSeconds: END_HOUR * 3600,
      isLoading: false,
      results: {
        samples: estateSamples(),
        volume: [],
        loads: {},
        sources: { obi: false, fallback: true },
      },
    };
    renderComponent({ mapping: mappingText });
    expect(screen.getByTestId("graph")).toBeInTheDocument();
    expect(screen.getByText("fallback script")).toBeInTheDocument();
    const ids = lastOption!.series[0]!.data.map((d) => d.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "portal",
        "oracle",
        "chip:oracle|db01",
        "ip:10.1.7.22",
      ]),
    );
  });
});

describe("DependencyMapView", () => {
  const model = estateModel();
  const o = resolveOptions({ mapping: mappingText, defaultView: "lanes" });
  const view = (
    over: Partial<Parameters<typeof DependencyMapView>[0]> = {},
  ): void => {
    render(
      <DependencyMapView
        model={model}
        o={o}
        mapping={parseMapping(mappingText).mapping}
        mappingText={mappingText}
        mappingErrors={[]}
        palette={palette}
        echartsTheme={{}}
        width={1200}
        height={700}
        nowSeconds={END_HOUR * 3600}
        {...over}
      />,
    );
  };

  it("failure mode: clicking a chip takes the host down and lists what breaks", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "What if" }));
    fireEvent.click(screen.getByText("click chip db01"));
    const scenario = screen.getByRole("region", { name: "Scenario" });
    expect(within(scenario).getByText(/Down:/)).toHaveTextContent("db01");
    expect(
      within(scenario).getByText(/hard-wired to db01/),
    ).toBeInTheDocument();
    expect(within(scenario).getByText("1 out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(
      within(screen.getByRole("region", { name: "Scenario" })).getByText(
        /Nothing is down/,
      ),
    ).toBeInTheDocument();
  });

  it("offers the worst single servers as presets when none are configured", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "What if" }));
    expect(
      screen.getByRole("button", { name: "10.1.7.22 down" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try 10.1.7.22 down" }),
    ).toBeInTheDocument();
  });

  it("frequency filter hides edges and counts them", () => {
    view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Monthly / rare" }));
    expect(screen.getAllByText(/hidden/).length).toBeGreaterThan(0);
    const ids = lastOption!.series[0]!.data.map((d) => d.id);
    // The partner FTP is only reached by the monthly job, so it leaves the map with its edge.
    expect(ids).not.toContain("ext:ftp.partner.example.com");
  });

  it("selecting a service shows its instances as toggles and its wave", () => {
    view();
    fireEvent.click(screen.getByText("click portal"));
    const group = screen.getByRole("group", { name: "Instances" });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    expect(
      within(group).getByRole("button", { name: "app01" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("firewall rules for the chosen wave", () => {
    view();
    const fw = screen.getByRole("region", { name: "Firewall rules" });
    expect(
      within(fw).getByText(
        /app01 \(10\.1\.1\.11\) -> ldap01 \(10\.1\.4\.1\):636\/tcp/,
      ),
    ).toBeInTheDocument();
  });

  it("narrow panels start with the side panel closed and open it on demand", () => {
    view({ width: 500 });
    expect(screen.queryByRole("region", { name: "Firewall rules" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(
      screen.getByRole("region", { name: "Firewall rules" }),
    ).toBeInTheDocument();
  });

  it("renders a large estate (150 services, 600 edges)", () => {
    const mapping: Mapping = {
      services: Array.from({ length: 150 }, (_, i) => ({
        id: `svc${i}`,
        wave: i % 4,
        instances: [{ host: `h${i}`, ip: `10.8.${i}.1` }],
      })),
      external: [],
    };
    const samples: EdgeSample[] = [];
    for (let i = 0; samples.length < 600; i++) {
      const a = i % 149;
      const b = a + 1 + ((i * 7) % (149 - a));
      if (
        samples.some((s) => s.src === `10.8.${a}.1` && s.dst === `10.8.${b}.1`)
      )
        continue;
      samples.push({
        src: `10.8.${a}.1`,
        dst: `10.8.${b}.1`,
        port: 443,
        hours: [1, 2, 3],
        lastSeen: 3 * 3600,
      });
    }
    const big = buildModel(mapping, samples, DEFAULT_THRESHOLDS, 24);
    const t0 = performance.now();
    view({ model: big, mappingText: "" });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(lastOption!.series[0]!.links).toHaveLength(600);
  });
});
