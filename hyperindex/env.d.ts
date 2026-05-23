declare namespace NodeJS {
  interface ProcessEnv {
    POLYGON_RPC_URL?: string;
  }
}

declare var process: {
  env: NodeJS.ProcessEnv;
};
