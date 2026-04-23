import type { RPCSchema } from "bunite-core";

export type ComputeParams = { a: number; b: number; op: "add" | "multiply" };

export type LogEntry = {
  from: string;
  expr: string;
  result: number;
  at: number;
};

export type CalcSchema = {
  bun: RPCSchema<{
    requests: {
      compute: { params: ComputeParams; response: number };
    };
  }>;
  webview: RPCSchema;
};

export type LogSchema = {
  bun: RPCSchema<{
    messages: { entry: LogEntry };
  }>;
  webview: RPCSchema;
};
