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
import { CfnOutput, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnFunction, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { GraphqlApi } from "aws-cdk-lib/aws-appsync";

import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { homeAgent } from "./functions/agent/resource";
import { homeScheduler } from "./functions/scheduler/resource";
import { recurringTasks } from "./functions/recurring-tasks/resource";

const backend = defineBackend({
  auth,
  data,
  homeAgent,
  homeScheduler,
  recurringTasks,
});

Tags.of(backend.stack).add("app", "home-hub");

// Lambda descriptions
const lambdaDescriptions: Record<string, string> = {
  homeAgent: "Home Hub — Anthropic agent (tasks, bills, calendar)",
  homeScheduler: "Home Hub — EventBridge reminder notifications (SNS)",
  recurringTasks: "Home Hub — Daily recurring task sweep",
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
    // separate opaque identifier exposed via graphqlUrl. Constructing the URL
    // from apiId produces a hostname that doesn't resolve. Amplify types this
    // as IGraphqlApi (which doesn't expose graphqlUrl) but the concrete
    // instance is a GraphqlApi, so we cast.
    APPSYNC_ENDPOINT: (backend.data.resources.graphqlApi as GraphqlApi).graphqlUrl,
    S3_BUCKET: "cristinegennaro.com",
    S3_AUTH_PREFIX: "whatsapp-bot/auth",
    WHATSAPP_GROUP_JID: process.env.WHATSAPP_GROUP_JID ?? "",
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
});

// Outputs on the root stack for the Amplify build phase to build/push Docker
new CfnOutput(backend.stack, "whatsappBotEcrRepoUri", {
  value: botRepo.repositoryUri,
});
new CfnOutput(backend.stack, "whatsappBotClusterArn", {
  value: botCluster.clusterArn,
});
new CfnOutput(backend.stack, "whatsappBotServiceName", {
  value: botService.serviceName,
});
