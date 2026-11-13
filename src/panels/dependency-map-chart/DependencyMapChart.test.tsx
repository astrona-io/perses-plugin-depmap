import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  estateModel,
  estateSamples,
  END_HOUR,
  WINDOW_HOURS,
} from "../../test-utils/estate";
import { DependencyMapChartComponent } from "./DependencyMapChartComponent";
import { DependencyMapView } from "./DependencyMapView";
import {
  DependencyMapChartOptions,
  DependencyMapChartProps,
  resolveOptions,
  DEFAULT_THRESHOLDS,
} from "./dependency-map-chart-types";
import { DepmapData } from "./useDepmapData";
import { Mapping, parseMapping } from "./mapping";
import { EdgeSample, buildModel } from "./model";

let mockData: DepmapData = { windowHours: 720, endSeconds: 0, isLoading: true };
jest.mock("./useDepmapData", () => ({ useDepmapData: () => mockData }));
jest.mock("@perses-dev/components", () => ({
  LoadingOverlay: () => <div role="progressbar">loading</div>,
}));

const mappingText = readFileSync(
  join(__dirname, "../../../dev/estate/mapping.yaml"),
  "utf8",
);
const dims = { width: 1200, height: 700 };

function renderComponent(spec: DependencyMapChartOptions): void {
  render(
    <DependencyMapChartComponent
      {...({
        spec,
        contentDimensions: dims,
      } as unknown as DependencyMapChartProps)}
    />,
  );
}

describe("DependencyMapChartComponent", () => {
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
    expect(screen.queryByTestId("depmap-estate")).toBeNull();
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
    expect(screen.getByTestId("depmap-estate")).toBeInTheDocument();
    expect(screen.getByText("fallback script")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Servers" }),
    ).toBeInTheDocument();
  });
});

describe("DependencyMapView", () => {
  const model = estateModel();
  const o = resolveOptions({ mapping: mappingText });
  const view = (
    over: Partial<Parameters<typeof DependencyMapView>[0]> = {},
  ): void => {
    render(
      <DependencyMapView
        model={model}
        o={o}
        mapping={parseMapping(mappingText).mapping}
        mappingErrors={[]}
        width={1200}
        height={700}
        {...over}
      />,
    );
  };

  it("if unreachable: marking a server host lists what stops and what loses it", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "If unreachable" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Mark app03 unreachable" }),
    );
    expect(
      screen.getByRole("button", { name: "Mark app03 unreachable" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("ran only on app03")).toBeInTheDocument();
    expect(screen.getByText(/^Lose a dependency · [1-9]/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("ran only on app03")).toBeNull();
  });

  it("if unreachable: ranks every unit tried alone", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "If unreachable" }));
    expect(
      screen.getByRole("button", { name: "Try app03 alone" }),
    ).toBeInTheDocument();
  });

  it("frequency filter hides edges and counts them", () => {
    view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Monthly / rare" }));
    expect(screen.getAllByText(/hidden/).length).toBeGreaterThan(0);
  });

  it("the servers page copies firewall rules per wave", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Open Servers" }));
    expect(
      screen.getByRole("button", { name: "Copy wave 1" }),
    ).toBeInTheDocument();
  });

  it("narrow panels start with the side panel closed and open it on demand", () => {
    view({ width: 500 });
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(
      screen.getByRole("complementary", { name: "Details" }),
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
    expect(big.edges).toHaveLength(600);
    const t0 = performance.now();
    view({ model: big, mapping });
    fireEvent.click(screen.getByRole("button", { name: "If unreachable" }));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(screen.getByTestId("depmap-estate")).toBeInTheDocument();
  });
});
