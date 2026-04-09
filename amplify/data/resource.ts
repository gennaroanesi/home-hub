import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { homeAgent } from "../functions/agent/resource";

const schema = a
  .schema({
    homeTask: a
      .model({
        title: a.string().required(),
        description: a.string(),
        assignee: a.enum(["gennaro", "cristine", "both"]),
        dueDate: a.datetime(),
        isCompleted: a.boolean().default(false),
        recurrence: a.string(),
        completedAt: a.datetime(),
        createdBy: a.string(),
      })
      .authorization((allow) => [allow.group("home-users")]),
    homeBill: a
      .model({
        name: a.string().required(),
        amount: a.float(),
        currency: a.string().default("USD"),
        dueDay: a.integer(),
        dueDate: a.datetime(),
        isRecurring: a.boolean().default(true),
        isPaid: a.boolean().default(false),
        paidAt: a.datetime(),
        category: a.string(),
        url: a.url(),
        notes: a.string(),
      })
      .authorization((allow) => [allow.group("home-users")]),
    homeCalendarEvent: a
      .model({
        title: a.string().required(),
        description: a.string(),
        startAt: a.datetime().required(),
        endAt: a.datetime(),
        isAllDay: a.boolean().default(false),
        assignee: a.enum(["gennaro", "cristine", "both"]),
        recurrence: a.string(),
        location: a.string(),
        reminderMinutes: a.integer(),
      })
      .authorization((allow) => [allow.group("home-users")]),
    homeConversation: a
      .model({
        title: a.string(),
        createdBy: a.string(),
        messages: a.hasMany("homeAgentMessage", "conversationId"),
      })
      .authorization((allow) => [allow.group("home-users")]),
    homeAgentMessage: a
      .model({
        conversationId: a.id().required(),
        conversation: a.belongsTo("homeConversation", "conversationId"),
        role: a.enum(["user", "assistant"]),
        content: a.string().required(),
        sender: a.string(),
        actionsTaken: a.json(),
      })
      .authorization((allow) => [allow.group("home-users")]),
    /* home agent */
    homeAgentAction: a.customType({
      tool: a.string().required(),
      result: a.json(),
    }),
    homeAgentResponse: a.customType({
      message: a.string().required(),
      actionsTaken: a.ref("homeAgentAction").array(),
    }),
    invokeHomeAgent: a
      .mutation()
      .authorization((allow) => [allow.group("home-users"), allow.authenticated("identityPool")])
      .arguments({
        message: a.string().required(),
        history: a.json(),
        sender: a.string(),
      })
      .returns(a.ref("homeAgentResponse"))
      .handler(a.handler.function(homeAgent)),
  })
  .authorization((allow) => [
    allow.resource(homeAgent),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
