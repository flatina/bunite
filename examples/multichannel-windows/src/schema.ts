import { call, defineCap, stream } from "bunite-core/rpc";

export type ComputeParams = { a: number; b: number; op: "add" | "multiply" };

export type LogEntry = {
  from: string;
  expr: string;
  result: number;
  at: number;
};

export const calcCap = defineCap("multichannel.calc", {
  compute: call<ComputeParams, number>(),
});

export const logCap = defineCap("multichannel.log", {
  entries: stream<void, LogEntry>(),
});
