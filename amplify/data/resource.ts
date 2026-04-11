import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { homeAgent } from "../functions/agent/resource";
import { recurringTasks } from "../functions/recurring-tasks/resource";
import { dailySummary } from "../functions/daily-summary/resource";
import { faceDetector } from "../functions/face-detector/resource";
import { retroactiveFaceMatch } from "../functions/retroactive-face-match/resource";
import { hassSync } from "../functions/hass-sync/resource";

// Reusable location shape for trips, days, and events
const locationCustomType = a.customType({
  city: a.string(),
  country: a.string(),
  latitude: a.float(),
  longitude: a.float(),
  timezone: a.string(),
  // Optional airport code for flight legs. Accepts whatever the user gives
  // us — ICAO (KAUS), IATA (AUS), or private field codes (TX99). No
  // validation; stored as-entered.
  airportCode: a.string(),
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
        // Home Assistant device_tracker entity for this person's phone
        // (e.g. "device_tracker.gennaro_iphone"). Populated by Unifi
        // integration. Used by the v2 risk matrix to detect whether an
        // action is being requested from home wifi.
        homeDeviceTrackerEntity: a.string(),
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
        reservations: a.hasMany("homeTripReservation", "tripId"),
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

    // ── Trip Reservation ────────────────────────────────────────────────
    // Non-transportation bookings for a trip: hotels, car rentals,
    // tickets, tours, etc. Separate from homeTripLeg because legs are
    // strictly about getting from A to B.
    //
    // TIME CONVENTION: startAt/endAt follow the SAME local-wall-clock
    // rule as homeTripLeg.departAt/arriveAt — an ISO 8601 string with a
    // "Z" suffix that is a syntactic placeholder only (NOT UTC). A 3:00
    // PM check-in in Rome is stored as "2026-07-02T15:00:00.000Z"
    // regardless of where the entry is made from. Use the helpers in
    // lib/trip.ts (parseLegIso / formatLegTime / legIsoToLocalDate) to
    // display these values — never run them through new Date().
    homeTripReservation: a
      .model({
        tripId: a.id().required(),
        trip: a.belongsTo("homeTrip", "tripId"),
        type: a.enum([
          "HOTEL",
          "CAR_RENTAL",
          "TICKET",
          "TOUR",
          "RESTAURANT",
          "ACTIVITY",
          "OTHER",
        ]),
        name: a.string().required(),
        startAt: a.datetime(),
        endAt: a.datetime(),
        location: locationCustomType,
        confirmationCode: a.string(),
        url: a.url(),
        cost: a.float(),
        currency: a.string(),
        notes: a.string(),
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
        isFavorite: a.boolean().default(false),
        // Source provider for imports (e.g. "lightroom"). Lets us dedup
        // re-runs of the import script via the asset id below.
        sourceProvider: a.string(),
        sourceAssetId: a.string(),
        // Many-to-many membership in albums via the homeAlbumPhoto join
        albums: a.hasMany("homeAlbumPhoto", "photoId"),
      })
      .secondaryIndexes((index) => [index("takenAt"), index("sourceAssetId")])
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

    // ── PersonFace (Rekognition enrollment) ─────────────────────────────
    // One row per face vector enrolled in the Rekognition collection for
    // a household member. A person can have multiple enrolled faces
    // (different angles, glasses on/off, etc) — when matching we accept a
    // hit on any of them.
    homePersonFace: a
      .model({
        personId: a.id().required(),
        // Rekognition FaceId returned by IndexFaces. Used to match
        // SearchFacesByImage hits back to a person.
        rekognitionFaceId: a.string().required(),
        // Optional: which photo this enrollment was created from (so we
        // can show the source thumbnail in the admin UI).
        enrolledFromPhotoId: a.id(),
        // Detection confidence at enrollment time (0-100).
        confidence: a.float(),
      })
      .secondaryIndexes((index) => [
        index("personId"),
        index("rekognitionFaceId"),
      ])
      .authorization((allow) => [
        allow.group("home-users"),
        // Schema-level allow.resource(faceDetector) is not enough on its
        // own — Amplify Gen 2 treats per-model auth rules as exclusive,
        // so we need an explicit IAM/identity-pool grant here for the
        // face-detector lambda to read the index. Same pattern as
        // homeOutboundMessage which is queried by the daily-summary lambda.
        allow.authenticated("identityPool"),
      ]),

    // ── PhotoFace (detected face on a photo) ────────────────────────────
    // One row per face detected on a photo by the face-detection lambda.
    // personId is null when the face was detected but not matched to any
    // enrolled person (admin can later assign it via /admin/faces).
    homePhotoFace: a
      .model({
        photoId: a.id().required(),
        // Optional FK → homePerson. Null until matched.
        personId: a.id(),
        // The Rekognition FaceId for the matched homePersonFace, if any.
        rekognitionFaceId: a.string(),
        // Match score 0-100 from SearchFacesByImage. Null if unmatched.
        similarity: a.float(),
        // BoundingBox from Rekognition: { Width, Height, Left, Top } in
        // image-relative coords (0-1). Used to draw the face rectangle.
        boundingBox: a.json(),
      })
      .secondaryIndexes((index) => [
        index("photoId"),
        index("personId"),
      ])
      .authorization((allow) => [
        allow.group("home-users"),
        // See note on homePersonFace above — face-detector lambda needs
        // explicit IAM access to write detected faces.
        allow.authenticated("identityPool"),
      ]),

    // ── Home Assistant Device ───────────────────────────────────────────
    // Cached catalog of Home Assistant entities we care about. Populated
    // by the hass-sync Lambda (daily + on-demand). The /devices page and
    // the agent read from this cache instead of hitting HA on every
    // request. Last known state is also cached here for quick reads.
    homeDevice: a
      .model({
        entityId: a.string().required(), // e.g. "climate.living_room"
        friendlyName: a.string(),
        domain: a.string(), // "climate" | "lock" | "cover" | "camera" | "switch" | "sensor" | ...
        area: a.string(), // e.g. "Living Room"
        // Sensitivity tier, set manually per device during enrollment.
        // Drives the risk matrix in lib/devicePolicy.ts.
        sensitivity: a.enum(["READ_ONLY", "LOW", "MEDIUM", "HIGH"]),
        // Whether this device appears on the /devices dashboard. Auto-set
        // to true for climate/lock/cover/camera domains on first sync.
        isPinned: a.boolean().default(false),
        // Last raw HA state blob (state string + attributes).
        lastState: a.json(),
        lastSyncedAt: a.datetime(),
      })
      .secondaryIndexes((index) => [index("entityId"), index("domain")])
      .authorization((allow) => [
        allow.group("home-users"),
        // Schema-level allow.resource(hassSync) is not enough on its
        // own — Amplify Gen 2 treats per-model auth rules as exclusive,
        // so we need an explicit IAM/identity-pool grant here for the
        // hass-sync lambda to write device state. Same pattern as
        // homePersonFace / homePhotoFace which the face-detector writes.
        allow.authenticated("identityPool"),
      ]),

    // ── Home Assistant Device Action (audit log) ────────────────────────
    // Scaffold for v2 — the /devices page and agent will write here on
    // every control attempt (success, fail, or denied by policy). Not
    // written to in v1 (read-only), but defined now so v2 doesn't need a
    // schema migration.
    homeDeviceAction: a
      .model({
        personId: a.id(),
        entityId: a.string().required(),
        action: a.string().required(), // e.g. "set_temperature", "lock", "unlock"
        params: a.json(),
        origin: a.enum(["UI", "AGENT"]),
        senderHomeWifi: a.boolean(),
        elevatedSession: a.boolean(),
        result: a.enum(["SUCCESS", "FAILED", "DENIED"]),
        error: a.string(),
      })
      .secondaryIndexes((index) => [index("entityId"), index("personId")])
      .authorization((allow) => [
        allow.group("home-users"),
        // v2 will have the hass-control lambda writing here on every
        // control attempt. Same per-model auth fix as homeDevice.
        allow.authenticated("identityPool"),
      ]),

    // ── Sync HA devices mutation ────────────────────────────────────────
    // Invokes the hass-sync Lambda on demand. Used by the /devices page
    // "Refresh" button and the agent. Same auth pattern as invokeHomeAgent.
    syncHomeDevices: a
      .mutation()
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ])
      .arguments({})
      .returns(
        a.customType({
          synced: a.integer().required(),
          hassAvailable: a.boolean().required(),
          error: a.string(),
        })
      )
      .handler(a.handler.function(hassSync)),

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

    // ── Retroactive face match ──────────────────────────────────────────
    // Called from /admin/faces after enrolling a face to a person. The
    // lambda runs SearchFaces against every enrolled face for that person
    // and bulk-updates matching unmatched homePhotoFace rows. Gated on
    // MIN_ENROLLMENTS (5) in the handler to avoid false-positive sweeps
    // from thin training data.
    retroactiveFaceMatchResponse: a.customType({
      status: a.string().required(), // "MATCHED" | "SKIPPED"
      reason: a.string(),
      enrolledCount: a.integer().required(),
      candidateCount: a.integer().required(),
      updatedCount: a.integer().required(),
    }),
    retroactiveFaceMatch: a
      .mutation()
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ])
      .arguments({
        personId: a.string().required(),
      })
      .returns(a.ref("retroactiveFaceMatchResponse"))
      .handler(a.handler.function(retroactiveFaceMatch)),
  })
  .authorization((allow) => [
    allow.resource(homeAgent),
    allow.resource(recurringTasks),
    allow.resource(dailySummary),
    allow.resource(faceDetector),
    allow.resource(retroactiveFaceMatch),
    allow.resource(hassSync),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
