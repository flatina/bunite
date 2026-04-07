import type { BuniteConfig } from "bunite/config";

export default {
  app: {
    name: "bunite-basic",
    identifier: "sh.flatina.bunite.basic",
    version: "0.0.0"
  },
  build: {
    bun: {
      entrypoint: "src/main.ts"
    },
    views: {
      main: {
        entrypoint: "src/renderer/index.ts"
      }
    },
    copy: {
      "src/renderer/index.html": "views/main/index.html"
    }
  },
  runtime: {
    exitOnLastWindowClosed: true,
    hideConsole: false
  }
} satisfies BuniteConfig;
