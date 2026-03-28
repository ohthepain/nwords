// app.config.ts
import { defineConfig } from "@tanstack/react-start/config";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
var app_config_default = defineConfig({
  vite: {
    plugins: [
      tailwindcss(),
      tsConfigPaths({
        projects: ["./tsconfig.json"]
      })
    ]
  }
});
export {
  app_config_default as default
};
