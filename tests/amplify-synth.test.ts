import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("Amplify backend", () => {
  it("synthesizes without circular dependency errors", { timeout: 120_000 }, () => {
    const result = execSync(
      "npx cdk synth --app 'npx tsx amplify/backend.ts' " +
        "-c amplify-backend-namespace=test " +
        "-c amplify-backend-name=test " +
        "-c amplify-backend-type=sandbox 2>&1",
      { encoding: "utf-8", timeout: 120_000 }
    );

    expect(result).not.toContain("Circular dependency between resources");
    expect(result).not.toContain(
      "EmptyOnDeleteRequiresDestroyRemovalPolicy"
    );
    expect(result).not.toContain("Error:");
  });
});
