import type { RpcSchema } from "bunite-core";

export type ComputeParams = { a: number; b: number; op: "add" | "multiply" };

export type LogEntry = {
  from: string;
  expr: string;
  result: number;
  at: number;
};

export type CalcSchema = {
  bun: RpcSchema<{
    requests: {
      compute: { params: ComputeParams; response: number };
    };
  }>;
  webview: RpcSchema;
};

export type LogSchema = {
  bun: RpcSchema<{
    messages: { entry: LogEntry };
  }>;
  webview: RpcSchema;
};
