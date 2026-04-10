import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { homeAgent } from "../functions/agent/resource";
import { recurringTasks } from "../functions/recurring-tasks/resource";

// Reusable location shape for trips, days, and events
const locationCustomType = a.customType({
  city: a.string(),
  country: a.string(),
  latitude: a.float(),
  longitude: a.float(),
  timezone: a.string(),
});

const schema = a
  .schema({
    // ── Person ──────────────────────────────────────────────────────────
    // One row per household member. Tasks/bills/events/days reference these.
    homePerson: a
      .model({
        name: a.string().required(),
        color: a.string(), // hex color for UI
        defaultTimezone: a.string(),
        emoji: a.string(),
        active: a.boolean().default(true),
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Trip ────────────────────────────────────────────────────────────
    // Multi-day trip; days and events reference trips via tripId.
    homeTrip: a
      .model({
        name: a.string().required(),
        type: a.enum(["LEISURE", "WORK", "FLYING", "FAMILY"]),
        startDate: a.date().required(),
        endDate: a.date().required(),
        destination: locationCustomType,
        notes: a.string(),
        participantIds: a.id().array(), // FK array → homePerson.id
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Calendar Day ────────────────────────────────────────────────────
    // One record per (date, person). Tracks status, location, PTO, trip link.
    homeCalendarDay: a
      .model({
        date: a.date().required(),
        personId: a.id().required(),
        status: a.enum([
          "WORKING_HOME",
          "WORKING_OFFICE",
          "TRAVEL",
          "VACATION",
          "WEEKEND_HOLIDAY",
          "PTO",
          "CHOICE_DAY",
        ]),
        timezone: a.string(),
        location: locationCustomType,
        notes: a.string(),
        ptoFraction: a.float().default(0),
        tripId: a.id(),
      })
      .secondaryIndexes((index) => [index("date"), index("personId")])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Task ────────────────────────────────────────────────────────────
    homeTask: a
      .model({
        title: a.string().required(),
        description: a.string(),
        assignedPersonIds: a.id().array(), // empty = household
        dueDate: a.datetime(),
        isCompleted: a.boolean().default(false),
        recurrence: a.string(),
        completedAt: a.datetime(),
        createdBy: a.string(),
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Bill ────────────────────────────────────────────────────────────
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
        assignedPersonIds: a.id().array(), // empty = household
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Calendar Event ──────────────────────────────────────────────────
    homeCalendarEvent: a
      .model({
        title: a.string().required(),
        description: a.string(),
        startAt: a.datetime().required(),
        endAt: a.datetime(),
        isAllDay: a.boolean().default(false),
        assignedPersonIds: a.id().array(), // empty = household
        recurrence: a.string(),
        location: locationCustomType,
        url: a.url(),
        reminderMinutes: a.integer(),
        tripId: a.id(),
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Agent ────────────────────────────────────────────────────────────
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
    allow.resource(recurringTasks),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
