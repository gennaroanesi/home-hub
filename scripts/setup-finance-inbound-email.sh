#!/usr/bin/env bash
# setup-finance-inbound-email.sh
#
# One-time (idempotent) setup for home-hub's finance inboxes:
#   paychecks@import.cristinegennaro.com → inbound bucket paychecks/ → paycheck-processor
#   invoices@import.cristinegennaro.com  → inbound bucket invoices/  → invoice-processor
#
# The bucket, its SES write policy and the S3 → Lambda notifications are
# CDK (amplify/backend.ts, FinanceInboundMailBucket). This script does what
# CDK here can't own:
#   1. SES domain identity for import.cristinegennaro.com (+ DKIM records)
#   2. Route53: MX for import.cristinegennaro.com → SES inbound, DKIM CNAMEs
#   3. Two receipt rules (spam/virus scanning on) in the account's ACTIVE
#      rule set. SES allows ONE active rule set per account+region and it's
#      shared with 91dispatcher and gennaroanesi.com, so this only adds or
#      updates its own two rules and never touches the set itself. A rule in
#      an inactive set silently bounces mail (gennaroanesi.com 2026-07-29).
#
# Usage:
#   AWS_PROFILE=admin scripts/setup-finance-inbound-email.sh            # dry run: prints the plan
#   AWS_PROFILE=admin scripts/setup-finance-inbound-email.sh --apply    # makes the changes
# Options:
#   --branch <name>   Amplify branch whose stack owns the bucket (default main)
#   --bucket <name>   Skip the stack lookup and use this bucket
#
# Needs admin-level credentials (SES receipt rules, Route53, CloudFormation
# read). amplify-dev can't manage SES receipt rules.

set -euo pipefail

REGION="us-east-1"
APP_ID="dkiwlyw3k1yfi"
ZONE_DOMAIN="cristinegennaro.com"
MAIL_DOMAIN="import.cristinegennaro.com"
PAYCHECKS="paychecks@${MAIL_DOMAIN}"
INVOICES="invoices@${MAIL_DOMAIN}"
BRANCH="main"
BUCKET=""
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --branch) BRANCH="$2"; shift ;;
    --bucket) BUCKET="$2"; shift ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
  shift
done

run() {
  if [ "$APPLY" = 1 ]; then "$@"; else echo "  [dry run] $*"; fi
}

echo "==> Inbound bucket"
if [ -z "$BUCKET" ]; then
  # describe-stacks paginates and the CLI applies --query to each page, so
  # pages without the output print "None": keep the one real value.
  BUCKET=$(aws cloudformation describe-stacks --region $REGION \
    --query "Stacks[?starts_with(StackName, 'amplify-${APP_ID}-${BRANCH}-')].Outputs[] | [?starts_with(OutputKey, 'FinanceInboundMailBucketName')].OutputValue" \
    --output text | tr '\t' '\n' | grep -v -x -e 'None' -e '' | sort -u)
fi
if [ "$(printf '%s\n' "$BUCKET" | grep -c .)" -gt 1 ]; then
  echo "ERROR: more than one FinanceInboundMailBucketName output on branch $BRANCH:"
  printf '  %s\n' $BUCKET
  echo "Pass the right one with --bucket."
  exit 1
fi
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: no FinanceInboundMailBucketName output on branch $BRANCH. Deploy first, or pass --bucket."
  exit 1
fi
echo "  $BUCKET"

echo ""
echo "==> SES identity $MAIL_DOMAIN"
if aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" --region $REGION >/dev/null 2>&1; then
  echo "  exists"
else
  run aws sesv2 create-email-identity --email-identity "$MAIL_DOMAIN" --region $REGION
fi
TOKENS=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" --region $REGION \
  --query "DkimAttributes.Tokens" --output text 2>/dev/null || true)

echo ""
echo "==> Route53 records in $ZONE_DOMAIN"
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_DOMAIN" \
  --query "HostedZones[?Name=='${ZONE_DOMAIN}.'].Id" --output text | tr '\t' '\n' | grep -v -x -e 'None' -e '' | head -1 | sed 's#/hostedzone/##')
if [ -z "$ZONE_ID" ] || [ "$ZONE_ID" = "None" ]; then
  echo "ERROR: no Route53 hosted zone for $ZONE_DOMAIN"
  exit 1
fi
CHANGES=$(python3 - "$MAIL_DOMAIN" "$REGION" "$TOKENS" <<'PY'
import json, sys
domain, region, tokens = sys.argv[1], sys.argv[2], sys.argv[3].split()
changes = [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": domain, "Type": "MX", "TTL": 300,
    "ResourceRecords": [{"Value": f"10 inbound-smtp.{region}.amazonaws.com"}]}}]
for t in tokens:
    if t and t != "None":
        changes.append({"Action": "UPSERT", "ResourceRecordSet": {
            "Name": f"{t}._domainkey.{domain}", "Type": "CNAME", "TTL": 1800,
            "ResourceRecords": [{"Value": f"{t}.dkim.amazonses.com"}]}})
print(json.dumps({"Comment": "home-hub finance inbound email", "Changes": changes}))
PY
)
echo "  zone $ZONE_ID: MX $MAIL_DOMAIN → inbound-smtp.$REGION.amazonaws.com, $(echo "$TOKENS" | wc -w) DKIM CNAME(s)"
[ -z "$TOKENS" ] && echo "  (DKIM tokens appear once the identity exists — re-run after --apply creates it)"
run aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "$CHANGES"

echo ""
echo "==> Receipt rules"
ACTIVE=$(aws ses describe-active-receipt-rule-set --region $REGION --query "Metadata.Name" --output text)
if [ -z "$ACTIVE" ] || [ "$ACTIVE" = "None" ]; then
  echo "ERROR: no active receipt rule set in $REGION"
  exit 1
fi
echo "  active rule set: $ACTIVE"

rule_json() { # name recipient prefix
  python3 -c '
import json, sys
name, rcpt, bucket, prefix = sys.argv[1:5]
print(json.dumps({"Name": name, "Enabled": True, "TlsPolicy": "Require", "ScanEnabled": True,
  "Recipients": [rcpt],
  "Actions": [{"S3Action": {"BucketName": bucket, "ObjectKeyPrefix": prefix}}]}))' "$1" "$2" "$BUCKET" "$3"
}

for spec in "home-hub-paychecks|$PAYCHECKS|paychecks/" "home-hub-invoices|$INVOICES|invoices/"; do
  IFS='|' read -r NAME RCPT PREFIX <<<"$spec"
  RULE=$(rule_json "$NAME" "$RCPT" "$PREFIX")
  if aws ses describe-receipt-rule --rule-set-name "$ACTIVE" --rule-name "$NAME" --region $REGION >/dev/null 2>&1; then
    echo "  $NAME exists → update ($RCPT → s3://$BUCKET/$PREFIX)"
    run aws ses update-receipt-rule --rule-set-name "$ACTIVE" --rule "$RULE" --region $REGION
  else
    echo "  $NAME new ($RCPT → s3://$BUCKET/$PREFIX)"
    run aws ses create-receipt-rule --rule-set-name "$ACTIVE" --rule "$RULE" --region $REGION
  fi
done

echo ""
if [ "$APPLY" = 1 ]; then
  echo "Done. Check: SES console → Verified identities ($MAIL_DOMAIN verified, DKIM successful),"
  echo "then email a stub from an allowed sender (FINANCE_INBOUND_ALLOWED_SENDERS) to $PAYCHECKS."
else
  echo "Dry run. Re-run with --apply to make these changes."
fi
