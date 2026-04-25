import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { homeAgent } from "../functions/agent/resource";
import { recurringTasks } from "../functions/recurring-tasks/resource";
import { dailySummary } from "../functions/daily-summary/resource";
import { faceDetector } from "../functions/face-detector/resource";
import { retroactiveFaceMatch } from "../functions/retroactive-face-match/resource";
import { hassSync } from "../functions/hass-sync/resource";
import { reminderSweep } from "../functions/reminder-sweep/resource";
import { icsSync } from "../functions/ics-sync/resource";

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
        // Cognito username for the household member this row
        // represents. Null for people we track but who don't log in
        // (kids, extended family, pets). Having a value is what makes
        // a person a "household member" for calendar display — and
        // the key we use to resolve the current UI user back to their
        // homePerson row (see lib/current-person.ts). Also sets up
        // per-user API scoping later without a schema migration.
        cognitoUsername: a.string(),
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
        // Non-null = imported from an external ICS feed (see
        // homeCalendarFeed); null = native event created in this app.
        // Imported events are read-only in the UI — any edits would
        // be overwritten on the next sync.
        feedId: a.id(),
        // ICS UID, used as the dedupe key within a feed so re-syncs
        // update rather than duplicate.
        externalUid: a.string(),
      })
      .secondaryIndexes((index) => [index("feedId")])
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

    // ── Calendar Feeds ────────────────────────────────────────────────────
    // External ICS subscription sources (e.g. a shared iCloud calendar
    // published as webcal). Synced every 15 minutes by the ics-sync
    // Lambda, which parses the feed and upserts homeCalendarEvent rows
    // keyed on (feedId, externalUid). One-way: changes made in the
    // source propagate in; edits in this app are blocked.
    homeCalendarFeed: a
      .model({
        name: a.string().required(),
        // webcal:// is rewritten to https:// by the sync handler.
        url: a.string().required(),
        // Hex colour used for rendering imported events on the
        // calendar so they're visually distinct from native ones.
        color: a.string(),
        active: a.boolean().default(true),
        lastSyncedAt: a.datetime(),
        // Populated with the error message on a failed sync; cleared
        // on the next successful run.
        lastSyncError: a.string(),
        // How many events are currently imported from this feed.
        // Maintained by the sync for the admin UI.
        eventCount: a.integer(),
      })
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

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

    // ── Document ──────────────────────────────────────────────────────────
    // Household document vault. Identity docs (passport, license, green
    // card), metadata-only entries (KTN, Global Entry), and insurance docs.
    // File reads are Duo-Push-gated at the agent tool layer (see wave 2).
    // The metadata itself (titles, types, expiration dates) is readable
    // without a challenge — only documentNumber and s3Key require Duo
    // approval before being surfaced.
    homeDocument: a
      .model({
        title: a.string().required(),
        type: a.enum([
          "DRIVERS_LICENSE",
          "PASSPORT",
          "GREEN_CARD",
          "TSA_PRECHECK",
          "GLOBAL_ENTRY",
          "INSURANCE",
          "OTHER",
        ]),
        // PERSONAL → ownerPersonId must be set. HOUSEHOLD → shared among all
        // home-users (e.g., home/auto insurance, marriage certificate).
        scope: a.enum(["PERSONAL", "HOUSEHOLD"]),
        ownerPersonId: a.id(),
        issuer: a.string(),
        // TOTP/Duo-gated at the agent tool layer. Never returned in
        // list_documents responses — only by verify_auth_and_get_link.
        documentNumber: a.string(),
        issuedDate: a.date(),
        expiresDate: a.date(),
        // Null for metadata-only entries (KTN, Global Entry number with no
        // file to upload).
        s3Key: a.string(),
        contentType: a.string(),
        sizeBytes: a.integer(),
        originalFilename: a.string(),
        notes: a.string(),
        uploadedBy: a.string(),
      })
      .secondaryIndexes((index) => [
        index("ownerPersonId"),
        index("type"),
        index("expiresDate"),
      ])
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

    // ── PersonAuth ─────────────────────────────────────────────────────────
    // Links a homePerson to their Duo username for Duo Push-based document
    // vault access. One row per enrolled person. Wave 2 adds the actual Duo
    // Auth API integration; wave 1 just stores the mapping so the /security
    // page can let users link themselves.
    homePersonAuth: a
      .model({
        personId: a.id().required(),
        // Duo username as configured in the Duo admin dashboard. Used by
        // the Auth API preauth/auth calls.
        duoUsername: a.string().required(),
        enrolledAt: a.datetime(),
        lastUsedAt: a.datetime(),
      })
      .secondaryIndexes((index) => [index("personId")])
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

    // ── PendingAuthChallenge ──────────────────────────────────────────────
    // Short-lived (5 min) row created when a user requests a document via
    // agent tool. Wave 2 verifies Duo Push approval against this row.
    homePendingAuthChallenge: a
      .model({
        // "wa:<chatJid>" or "web:<convId>" — uniquely identifies the
        // conversation that started the request so the agent can match
        // approval to request.
        conversationKey: a.string().required(),
        personId: a.id().required(),
        documentId: a.id().required(),
        attemptsRemaining: a.integer().default(3),
        expiresAt: a.datetime().required(),
      })
      .secondaryIndexes((index) => [index("conversationKey")])
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

    // ── DocumentAccessLog ─────────────────────────────────────────────────
    // Append-only audit of every document access attempt, for transparency
    // and security review. Wave 2 wires up the writes.
    homeDocumentAccessLog: a
      .model({
        documentId: a.id().required(),
        personId: a.id(),
        channel: a.enum(["WA", "WEB"]),
        action: a.enum([
          "LIST_METADATA",
          "DOWNLOAD_REQUEST",
          "AUTH_APPROVED",
          "AUTH_DENIED",
          "LINK_ISSUED",
        ]),
        result: a.enum(["SUCCESS", "DENIED", "FAILED"]),
        error: a.string(),
      })
      .secondaryIndexes((index) => [
        index("documentId"),
        index("personId"),
      ])
      .authorization((allow) => [
        allow.group("home-users"),
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

    // Manual trigger for the ICS feed sync, on top of the every-15-min
    // EventBridge schedule. Wired to the same icsSync Lambda — when the
    // user adds or edits a feed and doesn't want to wait, the admin
    // page can fire this.
    syncCalendarFeeds: a
      .mutation()
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ])
      .arguments({})
      .returns(
        a.customType({
          feedCount: a.integer().required(),
          totalEvents: a.integer().required(),
          created: a.integer().required(),
          updated: a.integer().required(),
          deleted: a.integer().required(),
          errors: a.string().array(),
        })
      )
      .handler(a.handler.function(icsSync)),

    // ── Attachment ───────────────────────────────────────────────────────
    // Generic file attachment linked to any parent entity via a polymorphic
    // parentType + parentId pair. Files live in S3 under
    // home/attachments/{parentType}/{parentId}/{uuid}.{ext}.
    homeAttachment: a
      .model({
        // INBOUND_MESSAGE / OUTBOUND_MESSAGE let the bot treat WA
        // attachments (images, PDFs, future video/audio) polymorphically —
        // no schema changes needed per new media type.
        parentType: a.enum([
          "TRIP",
          "TRIP_LEG",
          "RESERVATION",
          "EVENT",
          "TASK",
          "BILL",
          "INBOUND_MESSAGE",
          "OUTBOUND_MESSAGE",
        ]),
        parentId: a.id().required(),
        s3Key: a.string().required(),
        filename: a.string().required(),
        contentType: a.string(), // e.g. "image/jpeg", "application/pdf"
        sizeBytes: a.integer(),
        caption: a.string(),
        uploadedBy: a.string(), // "ui" | "agent" | person name
      })
      .secondaryIndexes((index) => [index("parentId")])
      .authorization((allow) => [
        allow.group("home-users"),
        // WA bot (ECS task role) and agent Lambda both write attachments
        // linked to inbound/outbound messages. Same IAM pattern as
        // homeOutboundMessage / homeInboundMessage.
        allow.authenticated("identityPool"),
      ]),

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

    // ── Checklist ──────────────────────────────────────────────────────────
    // Generic checklist that attaches to any entity via entityType + entityId.
    // An entity can have multiple checklists (e.g. a trip might have
    // "packing list" and "pre-departure checklist").
    homeChecklist: a
      .model({
        entityType: a.enum([
          "TRIP",
          "EVENT",
          "BILL",
          "DOCUMENT",
          "TASK",
          "TEMPLATE",
          "OTHER",
        ]),
        entityId: a.id().required(),
        name: a.string().required(),
        sortOrder: a.integer().default(0),
        items: a.hasMany("homeChecklistItem", "checklistId"),
      })
      .secondaryIndexes((index) => [
        index("entityType"),
        index("entityId"),
      ])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Checklist Item ─────────────────────────────────────────────────────
    homeChecklistItem: a
      .model({
        checklistId: a.id().required(),
        checklist: a.belongsTo("homeChecklist", "checklistId"),
        text: a.string().required(),
        // Optional section grouping within a checklist (e.g. "Clothes",
        // "Gear", "Documents" within a packing list). Items with the same
        // section string render under a shared heading. Null = ungrouped.
        section: a.string(),
        isDone: a.boolean().default(false),
        doneAt: a.datetime(),
        sortOrder: a.integer().default(0),
      })
      .secondaryIndexes((index) => [index("checklistId")])
      .authorization((allow) => [allow.group("home-users")]),

    // ── Inbound Message ──────────────────────────────────────────────────
    // Every WhatsApp message the bot receives is logged here before the
    // agent Lambda is invoked asynchronously. Provides:
    //   1. An idempotency key so Lambda async-invoke retries don't
    //      double-process (conditional write PENDING → PROCESSING).
    //   2. A structured, queryable audit trail for debugging "why didn't
    //      the bot respond to X?" — better than grepping CloudWatch.
    //   3. Correlation: agentLambdaRequestId links back to CloudWatch logs;
    //      outboundMessageId links to the delivered response.
    //
    // Attachments (images, PDFs, future video/audio) are stored as
    // homeAttachment rows with parentType="INBOUND_MESSAGE" so the bot
    // doesn't need to care about media type at the schema level.
    homeInboundMessage: a
      .model({
        // Stable WhatsApp message ID (msg.key.id). Used as a soft
        // idempotency hint in addition to the status lock.
        waMessageId: a.string().required(),
        chatJid: a.string().required(),
        senderJid: a.string().required(), // @lid or @s.whatsapp.net
        senderJidAlt: a.string(), // phone-based alt JID (for @lid messages)
        senderName: a.string(),
        senderPersonId: a.id(),
        channel: a.enum(["WA_GROUP", "WA_DM"]),
        text: a.string(),
        status: a.enum(["PENDING", "PROCESSING", "RESPONDED", "FAILED"]),
        outboundMessageId: a.id(),
        agentLambdaRequestId: a.string(),
        error: a.string(),
        processingStartedAt: a.datetime(),
        respondedAt: a.datetime(),
      })
      .secondaryIndexes((index) => [index("status"), index("waMessageId")])
      .authorization((allow) => [
        allow.group("home-users"),
        // WA bot (ECS task role) creates rows; agent Lambda (via its exec
        // role's identityPool auth) reads + updates status.
        allow.authenticated("identityPool"),
      ]),

    // ── Outbound Message ─────────────────────────────────────────────────
    // Generic delivery queue. Anything that needs to notify the household
    // (daily summaries, reminders, ad-hoc alerts) writes a row here; the
    // WhatsApp bot polls for PENDING rows and sends them. Decouples message
    // composition from delivery so the composer can run even if the bot is
    // offline — the message waits in the queue.
    //
    // Attachments (images, PDFs) are stored as homeAttachment rows with
    // parentType="OUTBOUND_MESSAGE"; the bot's outbound poller queries
    // them after sending the text and delivers each via the appropriate
    // WA media message type (image / document / future video).
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
        // Set when this message originated from a reminder sweep. Indexed
        // so the sweep can efficiently query "last N messages for this
        // reminder" to inject into the Haiku composition context.
        sourceReminderId: a.id(),
        // Which items within the reminder were bundled into this message.
        // Enables per-item acknowledgement in v2 ("I took the B12 but not
        // the Omega-3"). Array of item ids from reminder.items.
        sourceReminderItemIds: a.string().array(),
      })
      .secondaryIndexes((index) => [index("status"), index("sourceReminderId")])
      .authorization((allow) => [
        allow.group("home-users"),
        // WhatsApp bot (ECS task role) accesses this model directly via
        // IAM-signed GraphQL — same pattern as invokeHomeAgent.
        allow.authenticated("identityPool"),
      ]),

    // ── Reminder ──────────────────────────────────────────────────────────
    // Generic persistent reminder. Fires on a schedule, delivers to a
    // person or group via the outbound message queue. Replaces the old
    // EventBridge-per-schedule + SNS approach with a single reminder-sweep
    // Lambda that runs every 5 min and handles all reminders uniformly.
    //
    // Items model: a reminder is ALWAYS a collection of items, even for
    // simple single-item reminders. Each item has its own schedule (RRULE
    // or one-shot datetime). The sweep bundles items that are due in the
    // same firing window into one message. When useLlm=true, Haiku
    // composes the message text from the due items + recent message
    // history; when false, items are deterministically concatenated.
    //
    // Shape of each item in the `items` array:
    //   {
    //     id: string           — uuid, stable across edits
    //     name: string         — "Vitamin B12", "Take out the trash"
    //     notes?: string       — "take with food"
    //     firesAt?: string     — ISO datetime, for one-shot items
    //     rrule?: string       — RRULE string, for recurring items
    //     startDate?: string   — ISO date, earliest allowed fire
    //     endDate?: string     — ISO date, latest allowed fire
    //     lastFiredAt?: string — ISO datetime, set by sweep after each fire
    //   }
    // Exactly one of firesAt or rrule should be set per item.

    // ── Settings (singleton) ─────────────────────────────────────────────
    // Household-level configuration. By convention we only ever keep ONE
    // row here — the UI fetches the first row and treats it as the
    // global config. Lambdas do the same.
    //
    // Currently just the household timezone; designed to grow (default
    // airport ICAO, daily summary hour, etc).
    homeSettings: a
      .model({
        // IANA timezone name, e.g. "America/Chicago". Used by the reminder
        // sweep + daily summary to interpret picker-entered BYHOUR values
        // as household-local time. Falls back to "America/Chicago" if no
        // settings row exists.
        householdTimezone: a.string().required(),
      })
      .authorization((allow) => [
        allow.group("home-users"),
        allow.authenticated("identityPool"),
      ]),

    homeReminder: a
      .model({
        name: a.string().required(),
        items: a.json().required(),
        // When true, sweep calls Haiku to compose the message text from
        // the due items + recent history. When false, items are
        // concatenated deterministically ("Take your supplements:\n• …").
        useLlm: a.boolean().default(true),
        targetKind: a.enum(["PERSON", "GROUP"]),
        personId: a.id(),
        groupJid: a.string(),
        // Next time the sweep should check this reminder. Updated after
        // each firing to the earliest next-occurrence across all items
        // (minus the early-bias window).
        scheduledAt: a.datetime().required(),
        status: a.enum(["PENDING", "PAUSED", "EXPIRED", "CANCELLED"]),
        // Free-form label for filtering / display ("medication", "chore",
        // "adhoc", etc.). Not enforced.
        kind: a.string(),
        // Polymorphic link back to whatever entity spawned this reminder
        // (a task, calendar event, or trip). Null for ad-hoc reminders
        // created directly from the reminders page. Same pattern as
        // homeAttachment.parentType / parentId. When the parent is
        // deleted the UI cascades the delete; when a task is marked
        // complete the UI flips status to PAUSED.
        parentType: a.enum(["TASK", "EVENT", "TRIP"]),
        parentId: a.id(),
        createdBy: a.string(),
      })
      .secondaryIndexes((index) => [
        index("status"),
        index("scheduledAt"),
        index("parentId"),
      ])
      .authorization((allow) => [
        allow.group("home-users"),
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
        // S3 object keys (under home/agent-uploads/) for images the user
        // attached to this turn. The agent Lambda fetches each one,
        // base64-encodes it, and sends it as an image content block to
        // Claude alongside the text message. Optional.
        imageS3Keys: a.string().array(),
        // Chat context from the WA bot: { channel: "WA_GROUP"|"WA_DM"|"WEB",
        // chatJid: string|null }. Agent tools use this to decide whether to
        // redirect sensitive payloads to DM (group) or respond inline (DM/web).
        chatContext: a.json(),
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
    allow.resource(reminderSweep),
    allow.resource(icsSync),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
