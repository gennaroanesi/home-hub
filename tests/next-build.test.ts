import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

describe("Next.js", () => {
  it("builds successfully", { timeout: 300_000 }, () => {
    // next build rewrites next-env.d.ts to point at its distDir; put the
    // committed version back afterwards so the tree stays clean.
    const nextEnv = readFileSync("next-env.d.ts", "utf-8");
    let result: string;
    try {
      result = execSync("npm run build 2>&1", {
        encoding: "utf-8",
        timeout: 300_000,
        // Separate output dir so a running dev server's .next survives.
        env: { ...process.env, NEXT_DIST_DIR: ".next-test" },
      });
    } finally {
      writeFileSync("next-env.d.ts", nextEnv);
    }

    expect(result).toContain("Generating static pages");
    expect(result).not.toContain("Build failed");
    expect(result).not.toContain("Build error");
  });
});
