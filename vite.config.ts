import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.ts"],
    // セッション生成を何十回も回すテストがあり、CIの遅いランナーでは既定の5秒を超えることがある
    testTimeout: 30_000,
  },
} as Parameters<typeof defineConfig>[0]);
