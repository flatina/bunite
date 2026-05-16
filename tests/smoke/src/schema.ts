import { call, defineCap } from "bunite-core/rpc";

export const apiCap = defineCap("smoke.api", {
  ping: call<{ value: string }, { pong: string }>(),
});
