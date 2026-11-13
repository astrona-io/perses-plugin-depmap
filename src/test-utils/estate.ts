import { readFileSync } from "fs";
import { resolve } from "path";
import { DEFAULT_THRESHOLDS } from "../panels/dependency-map-chart/dependency-map-chart-types";
import { parseMapping } from "../panels/dependency-map-chart/mapping";
import {
  DepModel,
  EdgeSample,
  buildModel,
} from "../panels/dependency-map-chart/model";

/** The example estate of dev/ (dev/estate/mapping.yaml and flows.tsv), for the unit tests. */

const DIR = resolve(__dirname, "../../dev/estate");
export const MAPPING_YAML = readFileSync(resolve(DIR, "mapping.yaml"), "utf8");
export const FLOWS_TSV = readFileSync(resolve(DIR, "flows.tsv"), "utf8");

export const WINDOW_HOURS = 30 * 24;
/** 2026-11-13 12:00 UTC, in hours since the epoch. */
export const END_HOUR = Date.UTC(2026, 10, 13, 12) / 3600000;

export interface Flow {
  srcHost: string;
  srcIp: string;
  process: string;
  dstIp: string;
  port: number;
  schedule: string;
}

export function parseFlows(text: string): Flow[] {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [srcHost, srcIp, process, dstIp, port, schedule] = l.split("\t");
      return {
        srcHost: srcHost!,
        srcIp: srcIp!,
        process: process!,
        dstIp: dstIp!,
        port: Number(port),
        schedule: schedule!,
      };
    });
}

/** Whether a flow's schedule has it running in the given hour (hours since the epoch, UTC). */
export function runsInHour(schedule: string, hour: number): boolean {
  const d = new Date(hour * 3600000);
  const h = d.getUTCHours();
  if (schedule === "constant") return true;
  let m = /^every:(\d+)h\+(\d+)$/.exec(schedule);
  if (m) return hour % Number(m[1]) === Number(m[2]);
  m = /^daily@(\d+)$/.exec(schedule);
  if (m) return h === Number(m[1]);
  m = /^weekly@(\d)@(\d+)$/.exec(schedule);
  if (m) return d.getUTCDay() === Number(m[1]) && h === Number(m[2]);
  if (schedule === "monthly") {
    const next = new Date(hour * 3600000 + 86400000);
    return next.getUTCDate() === 1 && h === 23;
  }
  throw new Error(`unknown schedule ${schedule}`);
}

export function estateSamples(
  windowHours = WINDOW_HOURS,
  endHour = END_HOUR,
): EdgeSample[] {
  return parseFlows(FLOWS_TSV).map((f) => {
    const hours: number[] = [];
    for (let h = endHour - windowHours + 1; h <= endHour; h++)
      if (runsInHour(f.schedule, h)) hours.push(h);
    return {
      src: f.srcIp,
      dst: f.dstIp,
      port: f.port,
      srcProcess: f.process,
      hours,
      lastSeen: hours.length ? hours[hours.length - 1]! * 3600 : 0,
    };
  });
}

export function estateModel(): DepModel {
  const { mapping, errors } = parseMapping(MAPPING_YAML);
  if (errors.length) throw new Error(errors.join("\n"));
  return buildModel(mapping, estateSamples(), DEFAULT_THRESHOLDS, WINDOW_HOURS);
}
