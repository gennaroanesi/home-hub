import type { Handler } from "aws-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const sns = new SNSClient({});
const TOPIC_ARN = process.env.HOME_NOTIFICATIONS_TOPIC_ARN!;

interface ReminderEvent {
  assignee: "gennaro" | "cristine" | "both";
  message: string;
  type: "task" | "bill" | "event";
}

export const handler: Handler<ReminderEvent> = async (event) => {
  console.log("Reminder triggered", JSON.stringify(event));

  const { assignee, message, type } = event;

  const subject = `Home ${type} reminder`;

  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN,
    Message: `[${assignee}] ${message}`,
    Subject: subject,
    MessageAttributes: {
      assignee: { DataType: "String", StringValue: assignee },
      type: { DataType: "String", StringValue: type },
    },
  }));

  console.log(`Notification published to SNS for ${assignee}`);
  return { statusCode: 200 };
};
