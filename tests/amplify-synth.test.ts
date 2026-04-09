import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const CDK_OUT = "cdk.out";
const CDK_SYNTH_CMD =
  "npx cdk synth --app 'npx tsx amplify/backend.ts' " +
  "-c amplify-backend-namespace=test " +
  "-c amplify-backend-name=test " +
  "-c amplify-backend-type=sandbox 2>&1";

describe("Amplify backend", () => {
  it("synthesizes without errors", { timeout: 120_000 }, () => {
    const result = execSync(CDK_SYNTH_CMD, {
      encoding: "utf-8",
      timeout: 120_000,
    });

    expect(result).not.toContain("Circular dependency between resources");
    expect(result).not.toContain(
      "EmptyOnDeleteRequiresDestroyRemovalPolicy"
    );
    expect(result).not.toContain("Error:");
  });

  it("has no circular dependencies between nested stacks", { timeout: 10_000 }, () => {
    // Parse the root template to extract nested stack dependencies
    const rootTemplateFile = readdirSync(CDK_OUT).find(
      (f) => f.endsWith(".template.json") && !f.includes(".nested.")
    );
    expect(rootTemplateFile).toBeDefined();

    const template = JSON.parse(
      readFileSync(join(CDK_OUT, rootTemplateFile!), "utf-8")
    );
    const resources = template.Resources ?? {};

    // Build dependency graph: for each nested stack, find what it DependsOn
    const nestedStacks: Record<string, string[]> = {};
    for (const [logicalId, res] of Object.entries(resources) as [string, any][]) {
      if (res.Type === "AWS::CloudFormation::Stack") {
        const deps: string[] = res.DependsOn ?? [];
        // Also check for Ref / Fn::GetAtt references in Properties to other nested stacks
        const propsStr = JSON.stringify(res.Properties ?? {});
        for (const [otherId, otherRes] of Object.entries(resources) as [string, any][]) {
          if (
            otherId !== logicalId &&
            (otherRes as any).Type === "AWS::CloudFormation::Stack" &&
            propsStr.includes(otherId)
          ) {
            if (!deps.includes(otherId)) deps.push(otherId);
          }
        }
        nestedStacks[logicalId] = deps;
      }
    }

    // Detect cycles via DFS
    const visited = new Set<string>();
    const inPath = new Set<string>();
    const cyclePath: string[] = [];

    function hasCycle(node: string): boolean {
      if (inPath.has(node)) {
        cyclePath.push(node);
        return true;
      }
      if (visited.has(node)) return false;
      visited.add(node);
      inPath.add(node);
      for (const dep of nestedStacks[node] ?? []) {
        if (hasCycle(dep)) {
          cyclePath.push(node);
          return true;
        }
      }
      inPath.delete(node);
      return false;
    }

    for (const stack of Object.keys(nestedStacks)) {
      if (hasCycle(stack)) {
        throw new Error(
          `Circular dependency between nested stacks: ${cyclePath.reverse().join(" → ")}`
        );
      }
    }
  });
});
