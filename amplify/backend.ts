import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local for secrets not in the shell environment
try {
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

import { defineBackend } from "@aws-amplify/backend";
import { Policy, PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnFunction, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as codebuild from "aws-cdk-lib/aws-codebuild";

import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { homeAgent } from "./functions/agent/resource";
import { homeScheduler } from "./functions/scheduler/resource";
import { recurringTasks } from "./functions/recurring-tasks/resource";
import { dailySummary } from "./functions/daily-summary/resource";

const backend = defineBackend({
  auth,
  data,
  homeAgent,
  homeScheduler,
  recurringTasks,
  dailySummary,
});

Tags.of(backend.stack).add("app", "home-hub");

// Lambda descriptions
const lambdaDescriptions: Record<string, string> = {
  homeAgent: "Home Hub — Anthropic agent (tasks, bills, calendar)",
  homeScheduler: "Home Hub — EventBridge reminder notifications (SNS)",
  recurringTasks: "Home Hub — Daily recurring task sweep",
  dailySummary: "Home Hub — Daily summary composer (writes outbound message)",
};

for (const [key, desc] of Object.entries(lambdaDescriptions)) {
  const fn = (backend as any)[key]?.resources?.lambda;
  if (fn) {
    const cfnFn = (fn as LambdaFunction).node.defaultChild as CfnFunction;
    if (cfnFn) cfnFn.description = desc;
  }
}

// ── Data stack reference ────────────────────────────────────────────────────

const dataStack = Stack.of(backend.data.resources.tables["homeTask"]);

// ── Agent Lambda — Anthropic API + DynamoDB + Scheduler ─────────────────────

// EventBridge Scheduler role for the scheduler lambda
const schedulerRole = new iam.Role(dataStack, "homeSchedulerEventBridgeRole", {
  assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  inlinePolicies: {
    invokeLambda: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [backend.homeScheduler.resources.lambda.functionArn],
        }),
      ],
    }),
  },
});

// Agent lambda — EventBridge Scheduler access
const schedulerPolicy = new Policy(dataStack, "homeAgentSchedulerPolicy", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "scheduler:CreateSchedule",
        "scheduler:DeleteSchedule",
        "scheduler:GetSchedule",
        "iam:PassRole",
      ],
      resources: ["*"],
    }),
  ],
});
backend.homeAgent.resources.lambda.role?.attachInlinePolicy(schedulerPolicy);

// Env vars for agent lambda
// (Data access via Amplify data client; no DDB policies needed)
const agentLambda = backend.homeAgent.resources.lambda as LambdaFunction;
agentLambda.addEnvironment("SCHEDULER_LAMBDA_ARN", backend.homeScheduler.resources.lambda.functionArn);
agentLambda.addEnvironment("SCHEDULER_ROLE_ARN", schedulerRole.roleArn);
agentLambda.addEnvironment("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY ?? "");

// ── SNS topic for notifications ─────────────────────────────────────────────
// Topic lives in the scheduler stack (same as the lambda that publishes to it)
// to avoid a cross-stack circular dependency with the data stack.

const schedulerStack = Stack.of(backend.homeScheduler.resources.lambda);
const homeNotificationsTopic = new sns.Topic(schedulerStack, "homeNotificationsTopic", {
  displayName: "Home Hub Notifications",
});

const schedulerLambda = backend.homeScheduler.resources.lambda as LambdaFunction;
schedulerLambda.addEnvironment("HOME_NOTIFICATIONS_TOPIC_ARN", homeNotificationsTopic.topicArn);
homeNotificationsTopic.grantPublish(backend.homeScheduler.resources.lambda);

// ── Recurring tasks — daily sweep ───────────────────────────────────────────
// Data access via Amplify data client; no DDB env vars or policies needed.

const recurringStack = Stack.of(backend.recurringTasks.resources.lambda);
const recurringLambda = backend.recurringTasks.resources.lambda as LambdaFunction;

const recurringScheduleRole = new iam.Role(recurringStack, "recurringTasksSchedulerRole", {
  assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  inlinePolicies: {
    invokeLambda: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [recurringLambda.functionArn],
        }),
      ],
    }),
  },
});

// Run daily at 6am UTC
new scheduler.CfnSchedule(recurringStack, "recurringTasksDailySchedule", {
  scheduleExpression: "cron(0 6 * * ? *)",
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: recurringLambda.functionArn,
    roleArn: recurringScheduleRole.roleArn,
  },
});

// ── Daily summary ──────────────────────────────────────────────────────────
// Composes the household's morning summary (today + next 3 days) via
// Anthropic and writes it as a PENDING homeOutboundMessage. The WA bot
// picks it up from the queue and delivers it.

const dailySummaryLambda = backend.dailySummary.resources.lambda as LambdaFunction;
dailySummaryLambda.addEnvironment("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY ?? "");

const dailySummaryScheduleRole = new iam.Role(recurringStack, "dailySummarySchedulerRole", {
  assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  inlinePolicies: {
    invokeLambda: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [dailySummaryLambda.functionArn],
        }),
      ],
    }),
  },
});

// 12:00 UTC = 6am CST (winter) / 7am CDT (summer)
new scheduler.CfnSchedule(recurringStack, "dailySummarySchedule", {
  scheduleExpression: "cron(0 12 * * ? *)",
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: dailySummaryLambda.functionArn,
    roleArn: dailySummaryScheduleRole.roleArn,
  },
});

// ── WhatsApp bot — ECS Fargate + Baileys ────────────────────────────────────

const botStack = backend.createStack("whatsappBot");

const botVpc = new ec2.Vpc(botStack, "whatsappBotVpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
  ],
});

const botSg = new ec2.SecurityGroup(botStack, "whatsappBotSg", {
  vpc: botVpc,
  allowAllOutbound: true,
});
botSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), "QR pairing");

const botCluster = new ecs.Cluster(botStack, "whatsappBotCluster", {
  vpc: botVpc,
});

const botTaskDef = new ecs.FargateTaskDefinition(botStack, "whatsappBotTask", {
  cpu: 256,
  memoryLimitMiB: 512,
});

const botRepo = new ecr.Repository(botStack, "whatsappBotRepo", {
  emptyOnDelete: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

botTaskDef.addContainer("bot", {
  image: ecs.ContainerImage.fromEcrRepository(botRepo, "latest"),
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: "whatsapp-bot" }),
  portMappings: [{ containerPort: 8080 }],
  environment: {
    // AppSync's GraphQL hostname is NOT derived from the apiId — it's a
    // separate opaque identifier. Amplify Gen 2 types `resources.graphqlApi`
    // as an imported IGraphqlApi (no graphqlUrl exposed), but the real L1
    // CfnGraphQLApi is accessible at `resources.cfnResources.cfnGraphqlApi`.
    // This is the canonical path — Amplify's own factory.js uses it when
    // building the amplify_outputs GraphQL endpoint.
    APPSYNC_ENDPOINT: backend.data.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl,
    S3_BUCKET: "cristinegennaro.com",
    S3_AUTH_PREFIX: "whatsapp-bot/auth",
    // Default to the household group JID. Can be overridden via .env.local /
    // the shell env if you ever need to point the bot at a different group.
    // The bot uses this for both inbound mention filtering (when set, only
    // mentions in this group are processed) and outbound delivery (the
    // composer queues GROUP-targeted messages without a groupJid override
    // and the bot resolves them via this env var).
    WHATSAPP_GROUP_JID: process.env.WHATSAPP_GROUP_JID ?? "REDACTED@g.us",
    QR_ACCESS_TOKEN: process.env.QR_ACCESS_TOKEN ?? "",
    AWS_REGION: "us-east-1",
  },
});

botTaskDef.taskRole.addToPrincipalPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["appsync:GraphQL"],
  resources: [`${backend.data.resources.graphqlApi.arn}/*`],
}));

botTaskDef.taskRole.addToPrincipalPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  resources: ["arn:aws:s3:::cristinegennaro.com/whatsapp-bot/*"],
}));

// ListBucket is required so GetObject on a missing key returns 404 instead of 403
// (without it, S3 masks key existence). Scoped to the whatsapp-bot/ prefix.
botTaskDef.taskRole.addToPrincipalPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["s3:ListBucket"],
  resources: ["arn:aws:s3:::cristinegennaro.com"],
  conditions: {
    StringLike: { "s3:prefix": ["whatsapp-bot/*"] },
  },
}));

const botService = new ecs.FargateService(botStack, "whatsappBotService", {
  cluster: botCluster,
  taskDefinition: botTaskDef,
  desiredCount: 0,
  assignPublicIp: true,
  securityGroups: [botSg],
  vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
  // Stop the old task before starting the new one. Baileys can only have a
  // single linked-device session per WhatsApp account, so the default ECS
  // rolling deploy (overlapping old + new) makes both tasks fight, kicks
  // each other off WA, and crashes them. minHealthyPercent=0 lets ECS take
  // the service to zero during deploys; the brief downtime is acceptable
  // because the daily summary / reminder queue is durable in DynamoDB and
  // gets delivered as soon as the new task connects.
  //
  // AZ rebalancing must be DISABLED because ECS rejects maxHealthyPercent
  // ≤ 100 when rebalancing is enabled. We're a single-task bot and the
  // cluster spans 2 AZs already; if an AZ goes down ECS just starts the
  // replacement task in the surviving AZ. We don't need active rebalancing.
  minHealthyPercent: 0,
  maxHealthyPercent: 100,
  availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
});

// ── WA bot image build pipeline ─────────────────────────────────────────────
// Amplify Hosting's build environment has no Docker daemon and no ECR
// permissions, so it can't build the bot image directly. Instead, the
// Amplify postBuild step uploads a tar of whatsapp-bot/ to S3 and starts
// this CodeBuild project, which has Docker available and the right IAM.
// CodeBuild builds the image, pushes to ECR, force-redeploys the service,
// and writes a homeOutboundMessage row so the bot delivers a deploy result
// notification to the household WA group via the existing outbound poller.

const BUILD_ARTIFACTS_PREFIX = "whatsapp-bot/build";
// ITable.tableName resolves to a CFN token at synth time and to the real
// physical table name at deploy. Amplify creates one DynamoDB table per
// model in the data nested stack and exposes them via `resources.tables`.
const OUTBOUND_TABLE_NAME = backend.data.resources.tables["homeOutboundMessage"].tableName;

// No `projectName` override — CodeBuild project names are globally unique
// per account-region, and hardcoding one collides between the main branch
// and any active `npx ampx sandbox` deploy. Let CDK auto-generate based on
// the construct path. The Amplify build script discovers the actual name
// via the whatsappBotBuildProjectName CFN output below.
const botBuildProject = new codebuild.Project(botStack, "whatsappBotImageBuild", {
  description: "Build and push the home-hub WhatsApp bot Docker image",
  // The Amplify postBuild step overrides the source location per build with
  // a tar of whatsapp-bot/ uploaded to S3. This base value is just a
  // placeholder so CDK has a valid Source.s3() to construct.
  source: codebuild.Source.s3({
    bucket: s3.Bucket.fromBucketName(botStack, "BotBuildSrcBucket", "cristinegennaro.com"),
    path: `${BUILD_ARTIFACTS_PREFIX}/placeholder.tar.gz`,
  }),
  environment: {
    buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
    privileged: true, // required for docker buildx
    computeType: codebuild.ComputeType.SMALL,
  },
  timeout: Duration.minutes(15),
  environmentVariables: {
    ECR_URI: { value: botRepo.repositoryUri },
    AWS_DEFAULT_REGION: { value: botStack.region },
    CLUSTER_ARN: { value: botCluster.clusterArn },
    SERVICE_NAME: { value: botService.serviceName },
    OUTBOUND_TABLE: { value: OUTBOUND_TABLE_NAME },
    GROUP_JID: { value: process.env.WHATSAPP_GROUP_JID ?? "REDACTED@g.us" },
    // COMMIT_SHA is overridden per-build by the Amplify postBuild step.
    COMMIT_SHA: { value: "unknown" },
  },
  buildSpec: codebuild.BuildSpec.fromObject({
    version: "0.2",
    phases: {
      pre_build: {
        commands: [
          'echo "Building bot image for commit $COMMIT_SHA"',
          'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$(echo $ECR_URI | cut -d/ -f1)"',
        ],
      },
      build: {
        commands: [
          // CodeBuild's S3 source type extracts the tarball into
          // $CODEBUILD_SRC_DIR. The bot's Dockerfile lives at the root.
          'docker buildx build --platform linux/amd64 -t "$ECR_URI:latest" -t "$ECR_URI:$COMMIT_SHA" .',
          'docker push "$ECR_URI:latest"',
          'docker push "$ECR_URI:$COMMIT_SHA"',
        ],
      },
      post_build: {
        commands: [
          // Trigger ECS to pull the new image. Stop-then-start deploy
          // strategy is configured on the service itself.
          'aws ecs update-service --cluster "$CLUSTER_ARN" --service "$SERVICE_NAME" --force-new-deployment --no-cli-pager > /dev/null',
          // Notify the WA group via the outbound message queue. The bot's
          // existing poller picks PENDING rows up and delivers them within
          // ~30s of the new task connecting. We write the row directly to
          // DynamoDB rather than going through AppSync because CodeBuild
          // already has the table name and DDB perms — no signed GraphQL
          // request needed. The Amplify-managed table uses partition key
          // `id` and stores all model fields as DDB attributes.
          'STATUS_LABEL="✅ deployed"',
          'NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
          'MSG_ID="$(uuidgen | tr A-Z a-z)"',
          'TEXT="🤖 *Bot deploy ${STATUS_LABEL}* — ${COMMIT_SHA:0:7}"',
          // Use jq for safe JSON construction (handles quoting in TEXT).
          // jq is preinstalled on STANDARD_7_0.
          'jq -n --arg id "$MSG_ID" --arg now "$NOW" --arg text "$TEXT" --arg jid "$GROUP_JID" \'{id:{S:$id},__typename:{S:"homeOutboundMessage"},channel:{S:"WHATSAPP"},target:{S:"GROUP"},groupJid:{S:$jid},text:{S:$text},status:{S:"PENDING"},kind:{S:"deploy_notice"},createdAt:{S:$now},updatedAt:{S:$now}}\' > /tmp/item.json',
          'aws dynamodb put-item --table-name "$OUTBOUND_TABLE" --item file:///tmp/item.json --no-cli-pager',
          'echo "Queued deploy notice $MSG_ID"',
        ],
        // post_build's `finally` block runs even if the build phase failed.
        // We swap the success message for a failure one in that case.
        finally: [
          'if [ "$CODEBUILD_BUILD_SUCCEEDING" != "1" ]; then',
          '  STATUS_LABEL="❌ failed"',
          '  NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
          '  MSG_ID="$(uuidgen | tr A-Z a-z)"',
          '  TEXT="🤖 *Bot deploy ${STATUS_LABEL}* — ${COMMIT_SHA:0:7} (build $CODEBUILD_BUILD_ID)"',
          '  jq -n --arg id "$MSG_ID" --arg now "$NOW" --arg text "$TEXT" --arg jid "$GROUP_JID" \'{id:{S:$id},__typename:{S:"homeOutboundMessage"},channel:{S:"WHATSAPP"},target:{S:"GROUP"},groupJid:{S:$jid},text:{S:$text},status:{S:"PENDING"},kind:{S:"deploy_notice"},createdAt:{S:$now},updatedAt:{S:$now}}\' > /tmp/item.json',
          '  aws dynamodb put-item --table-name "$OUTBOUND_TABLE" --item file:///tmp/item.json --no-cli-pager || true',
          'fi',
        ],
      },
    },
  }),
});

// IAM for the CodeBuild project — minimum needed to:
//   - pull the source tar from the build-artifacts S3 prefix
//   - push to the bot's ECR repository
//   - force-redeploy the bot's ECS service
//   - put a row into the homeOutboundMessage table
botBuildProject.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["s3:GetObject", "s3:GetObjectVersion"],
    resources: [`arn:aws:s3:::cristinegennaro.com/${BUILD_ARTIFACTS_PREFIX}/*`],
  })
);
botRepo.grantPullPush(botBuildProject);
// ECR auth token is account-wide, not per-repo
botBuildProject.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["ecr:GetAuthorizationToken"],
    resources: ["*"],
  })
);
botBuildProject.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["ecs:UpdateService", "ecs:DescribeServices"],
    resources: [botService.serviceArn],
  })
);
backend.data.resources.tables["homeOutboundMessage"].grantWriteData(botBuildProject);

// Outputs on the root stack for the Amplify build phase to find the
// CodeBuild project + S3 artifacts location and trigger a build.
new CfnOutput(backend.stack, "whatsappBotEcrRepoUri", {
  value: botRepo.repositoryUri,
});
new CfnOutput(backend.stack, "whatsappBotClusterArn", {
  value: botCluster.clusterArn,
});
new CfnOutput(backend.stack, "whatsappBotServiceName", {
  value: botService.serviceName,
});
new CfnOutput(backend.stack, "whatsappBotBuildProjectName", {
  value: botBuildProject.projectName,
});
new CfnOutput(backend.stack, "whatsappBotBuildArtifactsPrefix", {
  value: `s3://cristinegennaro.com/${BUILD_ARTIFACTS_PREFIX}`,
});
