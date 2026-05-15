import { call, defineCap, defineSchema } from "bunite-core/rpc";

export const apiCap = defineCap({
  ping: call<{ value: string }, { pong: string }>(),
});

export const schema = defineSchema({ roots: { api: apiCap } });
