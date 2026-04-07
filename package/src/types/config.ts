export interface BuniteConfig {
  app: {
    name: string;
    identifier: string;
    version: string;
    description?: string;
  };
  build?: {
    bun?: {
      entrypoint?: string;
    } & Omit<Parameters<typeof Bun.build>[0], "entrypoints" | "outdir" | "target">;
    views?: Record<
      string,
      {
        entrypoint: string;
      } & Omit<Parameters<typeof Bun.build>[0], "entrypoints" | "outdir" | "target">
    >;
    copy?: Record<string, string>;
    buildFolder?: string;
    artifactFolder?: string;
    targets?: string[];
    cefVersion?: string;
    watch?: string[];
  };
  runtime?: {
    exitOnLastWindowClosed?: boolean;
    hideConsole?: boolean;
  };
}
