import { call, defineCap, defineSchema, stream } from "bunite-core";

export type ComputeParams = { a: number; b: number; op: "add" | "multiply" };

export type LogEntry = {
  from: string;
  expr: string;
  result: number;
  at: number;
};

export const calcCap = defineCap({
  compute: call<ComputeParams, number>(),
});

export const logCap = defineCap({
  entries: stream<void, LogEntry>(),
});

export const schema = defineSchema({
  roots: { calc: calcCap, log: logCap },
  caps: [],
});
