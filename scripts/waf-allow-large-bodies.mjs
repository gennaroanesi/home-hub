// Stops the Amplify-created WAF from blocking request bodies over 8 KB, by
// switching SizeRestrictions_BODY in the AWS Core rule set from Block to Count.
// Every other rule keeps its action. Prints the change and stops unless --apply.
//
//   AWS_PROFILE=admin node scripts/waf-allow-large-bodies.mjs
//   AWS_PROFILE=admin node scripts/waf-allow-large-bodies.mjs --apply

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACL = { Name: "CreatedByAmplify-dkiwlyw3k1yfi-9e1503ca-1355-442d-9cfb-e5587990e7c9", Id: "04835818-fb13-4d80-90c2-48d866ee9ac5", Scope: "CLOUDFRONT" };
const GROUP = "AWSManagedRulesCommonRuleSet";
const RULE = "SizeRestrictions_BODY";
// update-web-acl replaces the whole ACL, so everything it accepts is carried over.
const CARRIED = ["DefaultAction", "Description", "Rules", "VisibilityConfig", "DataProtectionConfig", "CustomResponseBodies", "CaptchaConfig", "ChallengeConfig", "TokenDomains", "AssociationConfig", "OnSourceDDoSProtectionConfig", "ApplicationConfig"];

const aws = (...args) => execFileSync("aws", ["wafv2", ...args, "--region", "us-east-1", "--output", "json"], { encoding: "utf8" });

const { WebACL: acl, LockToken } = JSON.parse(aws("get-web-acl", "--name", ACL.Name, "--scope", ACL.Scope, "--id", ACL.Id));
const original = JSON.stringify(acl, null, 2);
console.log("Rules:");
for (const r of acl.Rules) console.log(`  ${r.Priority}  ${r.Name}`);

const rule = acl.Rules.find((r) => r.Statement?.ManagedRuleGroupStatement?.Name === GROUP);
if (!rule) {
  console.error(`\n${GROUP} isn't in this ACL, so nothing was changed.`);
  process.exit(1);
}
const group = rule.Statement.ManagedRuleGroupStatement;
const overrides = group.RuleActionOverrides ?? [];
const existing = overrides.find((o) => o.Name === RULE);
if (existing?.ActionToUse?.Count) {
  console.log(`\n${RULE} is already set to Count. Nothing to do.`);
  process.exit(0);
}
group.RuleActionOverrides = [...overrides.filter((o) => o.Name !== RULE), { Name: RULE, ActionToUse: { Count: {} } }];
console.log(`\nChange: ${rule.Name} / ${RULE} -> Count`);

if (!process.argv.includes("--apply")) {
  console.log("Dry run. Re-run with --apply to change the live firewall.");
  process.exit(0);
}

const backup = join(tmpdir(), `waf-backup-${Date.now()}.json`);
writeFileSync(backup, original);
const input = { ...ACL, LockToken };
for (const key of CARRIED) if (acl[key] !== undefined) input[key] = acl[key];
aws("update-web-acl", "--cli-input-json", JSON.stringify(input));
console.log(`Applied. The ACL as it was before: ${backup}`);
