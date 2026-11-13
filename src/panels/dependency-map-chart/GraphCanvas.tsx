import { ReactElement, useEffect, useRef } from "react";
import { init, type ECharts, type EChartsOption } from "echarts";

interface GraphCanvasProps {
  option: object;
  theme: string | object;
  width: number;
  height: number;
  /** Called with the node id when a node is clicked. */
  onNodeClick: (id: string) => void;
  /** Called with the edge id when an edge is clicked. */
  onEdgeClick: (id: string) => void;
  /** Called when the empty canvas is clicked. */
  onBlankClick: () => void;
}

/**
 * Renders with the shared `echarts` module rather than Perses' `EChart` component.
 *
 * `EChart` (in @perses-dev/components) draws with the host's own trimmed `echarts/core` build, which
 * has no `graph` series registered. The full `echarts` package that Perses shares with plugins through
 * module federation does, so the chart is created with its `init`.
 *
 * Options are merged (not replaced) on update so zoom and pan survive a refresh or a click.
 */
export function GraphCanvas({
  option,
  theme,
  width,
  height,
  onNodeClick,
  onEdgeClick,
  onBlankClick,
}: GraphCanvasProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const handlers = useRef({ onNodeClick, onEdgeClick, onBlankClick });
  handlers.current = { onNodeClick, onEdgeClick, onBlankClick };

  // (Re)create the chart when the theme changes (light/dark switch).
  useEffect(() => {
    if (!ref.current) return;
    const instance = init(ref.current, theme as never);
    chart.current = instance;
    let itemClicked = false;
    instance.on("click", (params) => {
      if (params.dataType === "node") {
        itemClicked = true;
        handlers.current.onNodeClick((params.data as { id: string }).id);
      } else if (params.dataType === "edge") {
        itemClicked = true;
        const raw = (params.data as { raw?: { id: string } }).raw;
        if (raw) handlers.current.onEdgeClick(raw.id);
      }
    });
    // zrender sees every click; ECharts' own click event fires first for items.
    instance.getZr().on("click", () => {
      if (!itemClicked) handlers.current.onBlankClick();
      itemClicked = false;
    });
    return () => {
      instance.dispose();
      chart.current = null;
    };
  }, [theme]);

  useEffect(() => {
    chart.current?.setOption(option as EChartsOption);
  }, [option, theme]);

  useEffect(() => {
    chart.current?.resize({ width, height });
  }, [width, height, theme]);

  return <div ref={ref} style={{ width, height }} />;
}
