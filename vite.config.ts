// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { existsSync } from "node:fs";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Deployment-specific values (account_id, custom domain routes, DOMAINS) can live
// in an untracked wrangler.local.jsonc; it replaces wrangler.jsonc when present.
const LOCAL_WRANGLER_CONFIG = "wrangler.local.jsonc";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      configPath: existsSync(LOCAL_WRANGLER_CONFIG) ? LOCAL_WRANGLER_CONFIG : undefined,
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
