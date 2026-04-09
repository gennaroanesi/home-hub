import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("Next.js", () => {
  it("builds successfully", { timeout: 300_000 }, () => {
    const result = execSync("npm run build 2>&1", {
      encoding: "utf-8",
      timeout: 300_000,
    });

    expect(result).toContain("Generating static pages");
    expect(result).not.toContain("Build failed");
    expect(result).not.toContain("Build error");
  });
});
