import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { homeAgent } from "../functions/agent/resource";
import { recurringTasks } from "../functions/recurring-tasks/resource";
import { dailySummary } from "../functions/daily-summary/resource";

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
        // E.164 phone number (e.g. +12125551234) used to DM this person via
        // the WhatsApp bot. Null = person only receives household/group messages.
        phoneNumber: a.string(),
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
        legs: a.hasMany("homeTripLeg", "tripId"),
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── Trip Leg ────────────────────────────────────────────────────────
    // One transportation segment of a trip (outbound flight, return drive,
    // multi-city flight, etc). A trip can have many legs.
    homeTripLeg: a
      .model({
        tripId: a.id().required(),
        trip: a.belongsTo("homeTrip", "tripId"),
        mode: a.enum([
          "COMMERCIAL_FLIGHT",
          "PERSONAL_FLIGHT",
          "CAR",
          "TRAIN",
          "BUS",
          "BOAT",
          "OTHER",
        ]),
        departAt: a.datetime(),
        arriveAt: a.datetime(),
        fromLocation: locationCustomType,
        toLocation: locationCustomType,
        confirmationCode: a.string(),
        url: a.url(),
        notes: a.string(),
        // Commercial flight fields
        airline: a.string(),
        flightNumber: a.string(),
        // Personal flight field
        aircraft: a.string(), // tail number, e.g. N12345
        sortOrder: a.integer().default(0),
      })
      .secondaryIndexes((index) => [index("tripId")])
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

    // ── Photo ──────────────────────────────────────────────────────────
    // Photos uploaded to the cristinegennaro.com bucket under
    // home/photos/... Stored with UUID filenames to avoid guessability.
    // Album photos live at home/photos/albums/{albumId}/{uuid}.{ext},
    // unfiled (no album) at home/photos/unfiled/{uuid}.{ext}.
    homePhoto: a
      .model({
        s3key: a.string().required(), // full S3 key (relative to bucket)
        originalFilename: a.string(), // e.g. "IMG_1234.JPG"
        contentType: a.string(), // e.g. "image/jpeg"
        sizeBytes: a.integer(),
        width: a.integer(),
        height: a.integer(),
        takenAt: a.datetime(), // from EXIF DateTimeOriginal
        // GPS coordinates extracted from EXIF (decimal degrees)
        latitude: a.float(),
        longitude: a.float(),
        altitude: a.float(),
        exifData: a.json(),
        uploadedBy: a.string(),
        caption: a.string(),
        // Many-to-many membership in albums via the homeAlbumPhoto join
        albums: a.hasMany("homeAlbumPhoto", "photoId"),
      })
      .secondaryIndexes((index) => [index("takenAt")])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Album ──────────────────────────────────────────────────────────
    // Named collection of photos. Albums can optionally link to one or
    // more trips so the trip detail page can surface them automatically.
    homeAlbum: a
      .model({
        name: a.string().required(),
        description: a.string(),
        coverPhotoId: a.id(), // optional FK → homePhoto for the album thumbnail
        tripIds: a.id().array(), // optional FK array → homeTrip
        createdBy: a.string(),
        // Future Lightroom integration
        lightroomAlbumId: a.string(),
        lightroomLastSyncedAt: a.datetime(),
        photos: a.hasMany("homeAlbumPhoto", "albumId"),
      })
      .authorization((allow) => [allow.group("home-users")]),

    // ── AlbumPhoto (junction) ──────────────────────────────────────────
    // Many-to-many between albums and photos. A photo can belong to
    // multiple albums.
    homeAlbumPhoto: a
      .model({
        albumId: a.id().required(),
        photoId: a.id().required(),
        sortOrder: a.integer().default(0),
        album: a.belongsTo("homeAlbum", "albumId"),
        photo: a.belongsTo("homePhoto", "photoId"),
      })
      .secondaryIndexes((index) => [index("albumId"), index("photoId")])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Shopping ────────────────────────────────────────────────────────
    // Multiple named lists (e.g. "Supermarket", "Home Depot"), each with items.
    homeShoppingList: a
      .model({
        name: a.string().required(),
        emoji: a.string(),
        sortOrder: a.integer().default(0),
        isArchived: a.boolean().default(false),
        archivedAt: a.datetime(),
        items: a.hasMany("homeShoppingItem", "listId"),
      })
      .authorization((allow) => [allow.group("home-users")]),

    homeShoppingItem: a
      .model({
        listId: a.id().required(),
        list: a.belongsTo("homeShoppingList", "listId"),
        name: a.string().required(),
        quantity: a.string(),
        notes: a.string(),
        isChecked: a.boolean().default(false),
        checkedAt: a.datetime(),
        addedBy: a.string(),
        sortOrder: a.integer().default(0),
      })
      .secondaryIndexes((index) => [index("listId")])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Outbound Message ─────────────────────────────────────────────────
    // Generic delivery queue. Anything that needs to notify the household
    // (daily summaries, reminders, ad-hoc alerts) writes a row here; the
    // WhatsApp bot polls for PENDING rows and sends them. Decouples message
    // composition from delivery so the composer can run even if the bot is
    // offline — the message waits in the queue.
    homeOutboundMessage: a
      .model({
        channel: a.enum(["WHATSAPP"]),
        // GROUP → bot sends to its configured default group JID (or groupJid
        // if set). PERSON → bot resolves personId → person.phoneNumber → DM.
        target: a.enum(["GROUP", "PERSON"]),
        personId: a.id(),
        groupJid: a.string(), // optional override for GROUP target
        text: a.string().required(),
        status: a.enum(["PENDING", "SENT", "FAILED"]),
        // Free-form label for filtering / dedupe, e.g. "daily_summary",
        // "task_reminder", "ad_hoc".
        kind: a.string(),
        sentAt: a.datetime(),
        error: a.string(),
      })
      .secondaryIndexes((index) => [index("status")])
      .authorization((allow) => [
        allow.group("home-users"),
        // WhatsApp bot (ECS task role) accesses this model directly via
        // IAM-signed GraphQL — same pattern as invokeHomeAgent.
        allow.authenticated("identityPool"),
      ]),

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
        attachments: a.json(), // [{ type, url, caption }] from agent tools
      })
      .authorization((allow) => [allow.group("home-users")]),
    homeAgentAction: a.customType({
      tool: a.string().required(),
      result: a.json(),
    }),
    // An attachment the agent wants to deliver alongside its text reply.
    // Currently used for photos: type="image", url=CloudFront URL,
    // caption=optional human-readable label.
    homeAgentAttachment: a.customType({
      type: a.string().required(), // "image" for now
      url: a.string().required(),
      caption: a.string(),
    }),
    homeAgentResponse: a.customType({
      message: a.string().required(),
      actionsTaken: a.ref("homeAgentAction").array(),
      attachments: a.ref("homeAgentAttachment").array(),
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
    allow.resource(dailySummary),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
