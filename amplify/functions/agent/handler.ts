import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
// Note: @aws-sdk/s3-request-presigner was removed. Document URLs use
// direct S3 public paths (bucket allows public reads on home/*, UUID is
// the unguessability gate). A future session should restrict home/documents/
// to private access and add a short-redirect endpoint.
import { env } from "$amplify/env/home-agent";
import type { Schema } from "../../data/resource";
import {
  DEFAULT_ICAO,
  fetchAirportWeather,
  getMorningWeatherBriefing,
} from "../../../lib/aviation-weather.js";
import { DOCUMENT_ACCESS_NOTIFICATIONS_ENABLED } from "../../../lib/feature-flags.js";
import { preauth as duoPreauth, pushAuth as duoPushAuth, authStatus as duoAuthStatus } from "./duo.js";
import { HassClient, entityDomain } from "./hass-client.js";
import { canPerform, type Sensitivity, type Action, type PolicyContext } from "../../../lib/devicePolicy.js";

const anthropic = new Anthropic();
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});

// ── Attachment helpers ───────────────────────────────────────────────────────
// User-uploaded images/PDFs live under home/agent-uploads/ (web UI) or
// home/messages/inbound/ (WhatsApp bot) in the photos bucket (PHOTOS_BUCKET
// env var, set in backend.ts). The agent Lambda has s3:GetObject scoped to
// both prefixes.

type MediaPayload = {
  kind: "image" | "pdf";
  mediaType: string;
  data: string; // base64
};

function inferImageMediaType(s3Key: string): string {
  const ext = s3Key.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

async function fetchS3AsBase64(s3Key: string): Promise<{ contentType: string; data: string }> {
  const bucket = process.env.PHOTOS_BUCKET;
  if (!bucket) throw new Error("PHOTOS_BUCKET env var not set");

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
  if (!res.Body) throw new Error(`Empty body for s3://${bucket}/${s3Key}`);

  // Body is a Node Readable in Lambda — collect into a Buffer.
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);

  return {
    contentType: res.ContentType ?? "application/octet-stream",
    data: buf.toString("base64"),
  };
}

// Back-compat: legacy callsites that only care about images.
async function fetchImageAsBase64(s3Key: string): Promise<MediaPayload> {
  const { contentType, data } = await fetchS3AsBase64(s3Key);
  return {
    kind: "image",
    mediaType: contentType.startsWith("image/") ? contentType : inferImageMediaType(s3Key),
    data,
  };
}

// Dispatch by content type. Used when loading homeAttachment rows whose
// contentType is authoritative (WA bot sets it from the actual mimetype).
async function fetchAttachmentAsMedia(s3Key: string, contentType: string): Promise<MediaPayload | null> {
  const { data, contentType: s3ContentType } = await fetchS3AsBase64(s3Key);
  const finalType = contentType || s3ContentType;
  if (finalType.startsWith("image/")) {
    return {
      kind: "image",
      mediaType: finalType.startsWith("image/") ? finalType : inferImageMediaType(s3Key),
      data,
    };
  }
  if (finalType === "application/pdf") {
    return { kind: "pdf", mediaType: "application/pdf", data };
  }
  // Unsupported media type — silently drop. The agent won't see it.
  console.warn(`[agent] Unsupported attachment contentType ${finalType} for ${s3Key}`);
  return null;
}

// Build a Claude user message content array from optional media + text.
// Returns the plain text string when there are no attachments, so the
// existing no-attachment path stays byte-identical.
function buildUserContent(
  media: MediaPayload[],
  text: string
): string | Anthropic.ContentBlockParam[] {
  if (media.length === 0) return text;
  const blocks: Anthropic.ContentBlockParam[] = media.map((m) => {
    if (m.kind === "pdf") {
      return {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: m.data,
        },
      };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: m.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: m.data,
      },
    };
  });
  blocks.push({ type: "text" as const, text });
  return blocks;
}

const MODEL_ID = "claude-sonnet-4-20250514";

const SCHEDULER_LAMBDA_ARN = process.env.SCHEDULER_LAMBDA_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

// ── Amplify data client (lazy init) ──────────────────────────────────────────

let _dataClient: ReturnType<typeof generateClient<Schema>> | null = null;

async function getDataClient() {
  if (_dataClient) return _dataClient;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _dataClient = generateClient<Schema>();
  return _dataClient;
}

// ── Person resolution ────────────────────────────────────────────────────────
// Resolves names like "Gennaro" / "Cristine" / ["both"] to person IDs.

let _peopleCache: { id: string; name: string }[] | null = null;

async function getPeople(): Promise<{ id: string; name: string }[]> {
  if (_peopleCache) return _peopleCache;
  const client = await getDataClient();
  const { data } = await client.models.homePerson.list();
  _peopleCache = (data ?? []).map((p) => ({ id: p.id, name: p.name }));
  return _peopleCache;
}

async function resolvePersonIds(names?: string[] | null): Promise<string[]> {
  if (!names || names.length === 0) return [];
  const people = await getPeople();
  // "both", "all", "household" → all people
  if (names.some((n) => ["both", "all", "household", "everyone"].includes(n.toLowerCase()))) {
    return people.map((p) => p.id);
  }
  const ids: string[] = [];
  for (const name of names) {
    const match = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) ids.push(match.id);
  }
  return ids;
}

// ── Tool definitions for Claude ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "create_task",
    description: "Create a household task. Use recurrence for repeating tasks (RRULE format).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household tasks.",
        },
        description: { type: "string" },
        dueDate: { type: "string", description: "ISO 8601 datetime" },
        recurrence: { type: "string", description: "RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "update_task",
    description: "Update fields on an existing task by its ID. Only the fields you pass are changed; omit fields to leave them untouched. To mark complete use complete_task instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        dueDate: {
          type: "string",
          description: "ISO 8601 datetime. Pass empty string to clear.",
        },
        recurrence: {
          type: "string",
          description: "RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO. Pass empty string to clear.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "list_tasks",
    description: "List open (incomplete) tasks. Optionally filter by person name.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: { type: "string", description: "Person name to filter by" },
      },
    },
  },
  {
    name: "create_bill",
    description: "Create a bill to track. Use dueDay for recurring monthly bills, dueDate for one-off.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        dueDay: { type: "integer", description: "Day of month (1-31) for recurring bills" },
        dueDate: { type: "string", description: "ISO 8601 datetime for one-off bills" },
        isRecurring: { type: "boolean" },
        category: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Empty/omitted for household.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "mark_bill_paid",
    description: "Mark a bill as paid by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        billId: { type: "string" },
      },
      required: ["billId"],
    },
  },
  {
    name: "list_bills",
    description: "List unpaid bills.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_event",
    description: "Create a calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        startAt: { type: "string", description: "ISO 8601 datetime" },
        endAt: { type: "string", description: "ISO 8601 datetime" },
        isAllDay: { type: "boolean" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        recurrence: { type: "string" },
        location: { type: "string" },
        reminderMinutes: { type: "integer" },
      },
      required: ["title", "startAt"],
    },
  },
  {
    name: "update_event",
    description: "Update fields on an existing calendar event by its ID. Only the fields you pass are changed; omit fields to leave them untouched.",
    input_schema: {
      type: "object" as const,
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        startAt: { type: "string", description: "ISO 8601 datetime" },
        endAt: {
          type: "string",
          description: "ISO 8601 datetime. Pass empty string to clear.",
        },
        isAllDay: { type: "boolean" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        recurrence: {
          type: "string",
          description: "RRULE string. Pass empty string to clear.",
        },
        location: { type: "string" },
        url: { type: "string" },
        reminderMinutes: { type: "integer" },
        tripId: {
          type: "string",
          description: "ID of a homeTrip to link this event to. Pass empty string to clear.",
        },
      },
      required: ["eventId"],
    },
  },
  {
    name: "list_calendar_events",
    description: "List calendar events. By default returns events starting today or later. Pass startDate/endDate to narrow to a specific window (e.g. today+tomorrow), or person to filter by household member. Returns events sorted by start time.",
    input_schema: {
      type: "object" as const,
      properties: {
        startDate: {
          type: "string",
          description: "ISO 8601 date or datetime — only events starting on/after this. Defaults to today (local).",
        },
        endDate: {
          type: "string",
          description: "ISO 8601 date or datetime — only events starting before this (exclusive).",
        },
        person: {
          type: "string",
          description: "Optional person name. Without it, household-level events are returned alongside everyone's.",
        },
      },
    },
  },
  {
    name: "list_trips",
    description: "List planned and active trips. By default returns upcoming and current trips (endDate today or later). Pass includePast=true to include trips that have already ended. Each trip includes its transportation legs (flights, drives, etc.) inline.",
    input_schema: {
      type: "object" as const,
      properties: {
        includePast: {
          type: "boolean",
          description: "Include trips that have already ended. Default false.",
        },
      },
    },
  },
  {
    name: "delete_event",
    description: "Hard-delete a calendar event by its ID. Use when the user says 'cancel'/'delete'/'remove' an event. There is no soft-delete, so this is irreversible.",
    input_schema: {
      type: "object" as const,
      properties: {
        eventId: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "create_trip",
    description: "Create a trip. Use for multi-day travel (leisure, work, flying, family). Destination is an optional structured location.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["LEISURE", "WORK", "FLYING", "FAMILY"],
        },
        startDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        endDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        destination: {
          type: "object",
          description: "Optional structured destination.",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
        notes: { type: "string" },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
      },
      required: ["name", "startDate", "endDate"],
    },
  },
  {
    name: "update_trip",
    description: "Update fields on an existing trip by its ID. Only the fields you pass are changed; omit fields to leave them untouched.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["LEISURE", "WORK", "FLYING", "FAMILY"],
        },
        startDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        endDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        destination: {
          type: "object",
          description: "Structured destination. Pass null to clear.",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
        notes: { type: "string", description: "Pass empty string to clear." },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
      },
      required: ["tripId"],
    },
  },
  {
    name: "delete_trip",
    description: "Hard-delete a trip by its ID. Cascade-deletes all transportation legs and reservations attached to the trip first (they are keyed by tripId). Irreversible.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
      },
      required: ["tripId"],
    },
  },
  {
    name: "create_trip_leg",
    description: "Add a transportation leg (flight, car, train, etc.) to a trip. Use this to record specific segments of travel alongside the parent trip. Airline/flightNumber apply to COMMERCIAL_FLIGHT; aircraft (tail number) applies to PERSONAL_FLIGHT. When the user mentions an airport by name or code (e.g. 'from Austin Bergstrom', 'KAUS', 'JFK', 'TX99'), fill fromLocation.airportCode / toLocation.airportCode — ICAO, IATA, or private field codes are all accepted and stored as the user provided.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
        mode: {
          type: "string",
          enum: [
            "COMMERCIAL_FLIGHT",
            "PERSONAL_FLIGHT",
            "CAR",
            "TRAIN",
            "BUS",
            "BOAT",
            "OTHER",
          ],
        },
        departAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE ORIGIN AIRPORT, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The trailing Z is a syntactic placeholder required by the storage format — it is NOT a UTC assertion. Do NOT perform any timezone conversion. If the user says '4:22 PM depart from Austin on July 2 2026', write literally '2026-07-02T16:22:00.000Z'. The HH:mm is always the local wall-clock time at the origin airport. Never convert to UTC, never apply an offset, never call any timezone function — just take the local time the user stated and format it with a Z suffix.",
        },
        arriveAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE DESTINATION AIRPORT, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The trailing Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion. If the flight AUS->EWR arrives at 9:14 PM local Newark time on July 2 2026, write literally '2026-07-02T21:14:00.000Z'. Example of a round trip: AUS->EWR departing 4:22 PM AUS -> arriving 9:14 PM EWR on 2026-07-02 stores as departAt='2026-07-02T16:22:00.000Z' and arriveAt='2026-07-02T21:14:00.000Z'. Return EWR->AUS departing 7:27 PM EWR -> arriving 10:33 PM AUS stores as departAt='2026-07-XXT19:27:00.000Z' and arriveAt='2026-07-XXT22:33:00.000Z'.",
        },
        fromLocation: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
            airportCode: {
              type: "string",
              description: "Optional airport code (ICAO like KAUS, IATA like AUS, or private field code like TX99). Store as the user provided.",
            },
          },
        },
        toLocation: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
            airportCode: {
              type: "string",
              description: "Optional airport code (ICAO like KAUS, IATA like AUS, or private field code like TX99). Store as the user provided.",
            },
          },
        },
        confirmationCode: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" },
        airline: { type: "string" },
        flightNumber: { type: "string" },
        aircraft: { type: "string", description: "Tail number for PERSONAL_FLIGHT, e.g. N12345" },
        sortOrder: { type: "integer" },
      },
      required: ["tripId"],
    },
  },
  {
    name: "update_trip_leg",
    description: "Update fields on an existing trip leg by its ID. Only the fields you pass are changed; omit fields to leave them untouched. When the user mentions an airport by name or code (e.g. 'KAUS', 'AUS', 'TX99'), fill fromLocation.airportCode / toLocation.airportCode — ICAO, IATA, or private field codes are all accepted and stored as the user provided.",
    input_schema: {
      type: "object" as const,
      properties: {
        legId: { type: "string" },
        mode: {
          type: "string",
          enum: [
            "COMMERCIAL_FLIGHT",
            "PERSONAL_FLIGHT",
            "CAR",
            "TRAIN",
            "BUS",
            "BOAT",
            "OTHER",
          ],
        },
        departAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE ORIGIN AIRPORT, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion; write the HH:mm the user stated for the origin airport literally. Example: '4:22 PM depart Austin 2026-07-02' -> '2026-07-02T16:22:00.000Z'. Pass empty string to clear.",
        },
        arriveAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE DESTINATION AIRPORT, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion; write the HH:mm the user stated for the destination airport literally. Example: 'arrive 9:14 PM Newark 2026-07-02' -> '2026-07-02T21:14:00.000Z'. Pass empty string to clear.",
        },
        fromLocation: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
            airportCode: {
              type: "string",
              description: "Optional airport code (ICAO like KAUS, IATA like AUS, or private field code like TX99). Store as the user provided.",
            },
          },
        },
        toLocation: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
            airportCode: {
              type: "string",
              description: "Optional airport code (ICAO like KAUS, IATA like AUS, or private field code like TX99). Store as the user provided.",
            },
          },
        },
        confirmationCode: { type: "string", description: "Pass empty string to clear." },
        url: { type: "string", description: "Pass empty string to clear." },
        notes: { type: "string", description: "Pass empty string to clear." },
        airline: { type: "string", description: "Pass empty string to clear." },
        flightNumber: { type: "string", description: "Pass empty string to clear." },
        aircraft: { type: "string", description: "Pass empty string to clear." },
        sortOrder: { type: "integer" },
      },
      required: ["legId"],
    },
  },
  {
    name: "delete_trip_leg",
    description: "Hard-delete a single trip leg (one flight/drive/etc.) by its ID. Does not delete the parent trip.",
    input_schema: {
      type: "object" as const,
      properties: {
        legId: { type: "string" },
      },
      required: ["legId"],
    },
  },
  {
    name: "list_trip_legs",
    description: "List all transportation legs for a given tripId, sorted by sortOrder then departAt. list_trips already inlines legs, so only call this when you have a specific tripId already and want just the legs.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
      },
      required: ["tripId"],
    },
  },
  {
    name: "create_trip_reservation",
    description:
      "Add a non-transportation reservation (hotel, car rental, ticket, tour, restaurant, activity, etc.) to a trip. For flights/trains/drives use create_trip_leg instead — reservations are for bookings that happen once you've already arrived somewhere.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
        type: {
          type: "string",
          enum: [
            "HOTEL",
            "CAR_RENTAL",
            "TICKET",
            "TOUR",
            "RESTAURANT",
            "ACTIVITY",
            "OTHER",
          ],
        },
        name: {
          type: "string",
          description: "Human-readable name, e.g. 'Hotel Roma' or 'Colosseum guided tour'.",
        },
        startAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE RESERVATION LOCATION, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The trailing Z is a syntactic placeholder required by the storage format — it is NOT a UTC assertion. Do NOT perform any timezone conversion. If the user says 'check in at 3:00 PM in Rome on July 2 2026', write literally '2026-07-02T15:00:00.000Z'. The HH:mm is always the local wall-clock time at the reservation location. Never convert to UTC, never apply an offset, never call any timezone function — just take the local time the user stated and format it with a Z suffix.",
        },
        endAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE RESERVATION LOCATION, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion. If the user says 'check out at 11:00 AM in Rome on July 5 2026', write literally '2026-07-05T11:00:00.000Z'. Example of a hotel stay: check-in 3:00 PM 2026-07-02, check-out 11:00 AM 2026-07-05 stores as startAt='2026-07-02T15:00:00.000Z' and endAt='2026-07-05T11:00:00.000Z'.",
        },
        location: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
        confirmationCode: { type: "string" },
        url: { type: "string" },
        cost: { type: "number" },
        currency: { type: "string", description: "ISO currency code, e.g. USD, EUR." },
        notes: { type: "string" },
        sortOrder: { type: "integer" },
      },
      required: ["tripId", "name"],
    },
  },
  {
    name: "update_trip_reservation",
    description:
      "Update fields on an existing trip reservation by its ID. Only the fields you pass are changed; omit fields to leave them untouched.",
    input_schema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string" },
        type: {
          type: "string",
          enum: [
            "HOTEL",
            "CAR_RENTAL",
            "TICKET",
            "TOUR",
            "RESTAURANT",
            "ACTIVITY",
            "OTHER",
          ],
        },
        name: { type: "string" },
        startAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE RESERVATION LOCATION, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion; write the HH:mm the user stated for the reservation location literally. Example: 'check in 3:00 PM Rome 2026-07-02' -> '2026-07-02T15:00:00.000Z'. Pass empty string to clear.",
        },
        endAt: {
          type: "string",
          description:
            "Local wall-clock time AT THE RESERVATION LOCATION, formatted as YYYY-MM-DDTHH:mm:ss.sssZ. The Z is a syntactic placeholder — NOT UTC. Do NOT perform timezone conversion; write the HH:mm the user stated for the reservation location literally. Example: 'check out 11:00 AM Rome 2026-07-05' -> '2026-07-05T11:00:00.000Z'. Pass empty string to clear.",
        },
        location: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
        confirmationCode: { type: "string", description: "Pass empty string to clear." },
        url: { type: "string", description: "Pass empty string to clear." },
        cost: { type: "number" },
        currency: { type: "string", description: "Pass empty string to clear." },
        notes: { type: "string", description: "Pass empty string to clear." },
        sortOrder: { type: "integer" },
      },
      required: ["reservationId"],
    },
  },
  {
    name: "delete_trip_reservation",
    description: "Hard-delete a single trip reservation by its ID. Does not delete the parent trip.",
    input_schema: {
      type: "object" as const,
      properties: {
        reservationId: { type: "string" },
      },
      required: ["reservationId"],
    },
  },
  {
    name: "list_trip_reservations",
    description: "List all reservations for a given tripId, sorted by sortOrder then startAt.",
    input_schema: {
      type: "object" as const,
      properties: {
        tripId: { type: "string" },
      },
      required: ["tripId"],
    },
  },
  {
    name: "set_calendar_day",
    description: "Upsert a homeCalendarDay row for a single (date, person) pair. If a row already exists it is updated; otherwise a new one is created. Use for marking PTO, remote/office days, travel days, etc. Returns whether the row was created or updated.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "ISO date (YYYY-MM-DD)" },
        person: { type: "string", description: "Person name (e.g. 'Gennaro' or 'Cristine')" },
        status: {
          type: "string",
          enum: [
            "WORKING_HOME",
            "WORKING_OFFICE",
            "TRAVEL",
            "VACATION",
            "WEEKEND_HOLIDAY",
            "PTO",
            "CHOICE_DAY",
          ],
        },
        timezone: { type: "string" },
        location: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            timezone: { type: "string" },
          },
        },
        notes: { type: "string" },
        ptoFraction: {
          type: "number",
          description: "Fraction of the day taken as PTO (0-1). Default 0.",
        },
        tripId: { type: "string", description: "Optional FK to a homeTrip" },
      },
      required: ["date", "person"],
    },
  },
  {
    name: "list_calendar_days",
    description: "List calendar day rows (status/PTO/location per person per date). Filter by date range with fromDate/toDate (both inclusive, YYYY-MM-DD) and optionally by person name.",
    input_schema: {
      type: "object" as const,
      properties: {
        fromDate: { type: "string", description: "Earliest date, YYYY-MM-DD. Defaults to today (local CT)." },
        toDate: { type: "string", description: "Latest date, YYYY-MM-DD (inclusive)." },
        person: { type: "string", description: "Optional person name filter." },
      },
    },
  },
  {
    name: "delete_task",
    description: "Hard-delete a task by its ID. Use ONLY when the user explicitly wants to remove a task entirely (e.g. 'delete that task', 'never mind, drop it'). For normal completion use complete_task instead — that sets isCompleted=true and handles recurrence.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "update_bill",
    description: "Update fields on an existing bill by its ID. Only the fields you pass are changed; omit fields to leave them untouched. To mark a bill as paid, use mark_bill_paid instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        billId: { type: "string" },
        name: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        dueDay: { type: "integer", description: "Day of month (1-31) for recurring bills" },
        dueDate: { type: "string", description: "ISO 8601 datetime. Pass empty string to clear." },
        isRecurring: { type: "boolean" },
        category: { type: "string", description: "Pass empty string to clear." },
        url: { type: "string", description: "Pass empty string to clear." },
        notes: { type: "string", description: "Pass empty string to clear." },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
      },
      required: ["billId"],
    },
  },
  {
    name: "delete_bill",
    description: "Hard-delete a bill by its ID. Use when the user wants to remove a bill entirely. To just mark it as paid, use mark_bill_paid instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        billId: { type: "string" },
      },
      required: ["billId"],
    },
  },
  {
    name: "update_shopping_list",
    description: "Update fields on an existing shopping list by its ID. For archive/unarchive use archive_shopping_list / unarchive_shopping_list.",
    input_schema: {
      type: "object" as const,
      properties: {
        listId: { type: "string" },
        name: { type: "string" },
        emoji: { type: "string" },
        sortOrder: { type: "integer" },
      },
      required: ["listId"],
    },
  },
  {
    name: "delete_shopping_list",
    description: "Hard-delete a shopping list by its ID. Cascade-deletes all items on the list first. Irreversible — prefer archive_shopping_list unless the user explicitly says 'delete'.",
    input_schema: {
      type: "object" as const,
      properties: {
        listId: { type: "string" },
      },
      required: ["listId"],
    },
  },
  {
    name: "update_shopping_item",
    description: "Update fields on an existing shopping item by its ID. For checking items off use check_shopping_item; to uncheck use uncheck_shopping_item.",
    input_schema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" },
        name: { type: "string" },
        quantity: { type: "string", description: "Pass empty string to clear." },
        notes: { type: "string", description: "Pass empty string to clear." },
        sortOrder: { type: "integer" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "delete_shopping_item",
    description: "Hard-delete a shopping item by its ID. Use when the user wants to fully remove an item (typo, added to the wrong list) rather than mark it as bought.",
    input_schema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "uncheck_shopping_item",
    description: "Un-check a shopping item by its ID (sets isChecked=false and clears checkedAt). Mirror of check_shopping_item — use when the user says they did NOT actually buy something or want to restore it to the active list.",
    input_schema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "list_shopping_lists",
    description: "List active shopping lists (e.g. Supermarket, Home Depot) with unchecked item counts. Pass includeArchived=true to also include archived lists.",
    input_schema: {
      type: "object" as const,
      properties: {
        includeArchived: { type: "boolean" },
      },
    },
  },
  {
    name: "archive_shopping_list",
    description: "Archive a shopping list (by name, fuzzy matched). Archived lists are hidden from the main view but kept as a record.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
      required: ["listName"],
    },
  },
  {
    name: "unarchive_shopping_list",
    description: "Unarchive a previously archived shopping list.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
      required: ["listName"],
    },
  },
  {
    name: "create_shopping_list",
    description: "Create a new shopping list. Only use when the user explicitly wants a new list that doesn't exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        emoji: { type: "string", description: "Single emoji character for the list" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_shopping_item",
    description: "Add an item to a shopping list, matched by list name (fuzzy, case-insensitive). If no list name is given, uses the Supermarket list by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string", description: "Name of the list, e.g. 'Supermarket' or 'Home Depot'. Fuzzy matched." },
        name: { type: "string", description: "Item name, e.g. 'olive oil'" },
        quantity: { type: "string", description: "Optional quantity, e.g. '2', '1 lb', '500g'" },
        notes: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_shopping_items",
    description: "List unchecked items in a shopping list (by name), or across all lists if no name given.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
    },
  },
  {
    name: "check_shopping_item",
    description: "Mark a shopping item as bought/checked by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "schedule_reminder",
    description:
      "Create a persistent reminder that fires on a schedule and delivers to WhatsApp. Use for one-off reminders ('pick up the kids at 3pm') or simple recurring ones ('every morning at 8am'). For multi-item reminders with different schedules per item (e.g. a supplement stack), use schedule_compound_reminder instead. Default target is the household group; pass personName to DM a specific person.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Short label for the reminder, e.g. 'Pick up kids', 'Morning vitamins'. Used internally and for listing.",
        },
        message: {
          type: "string",
          description: "The actual text that will be sent. If the user wants dynamic composition each time, pass a generic placeholder and set useLlm=true; Haiku will rewrite it at send time.",
        },
        firesAt: {
          type: "string",
          description: "ISO 8601 datetime for a one-shot reminder. Omit if using rrule.",
        },
        rrule: {
          type: "string",
          description: "RRULE string for a recurring reminder, e.g. 'RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0'. Omit if using firesAt.",
        },
        endDate: {
          type: "string",
          description: "Optional ISO date when a recurring reminder should stop (e.g. for a 10-day antibiotic course).",
        },
        personName: {
          type: "string",
          description: "Optional — if set, reminder DMs this person (requires their phoneNumber set). Otherwise delivered to the household group.",
        },
        useLlm: {
          type: "boolean",
          description: "If true (default false for simple reminders), Haiku composes the message text at send time using recent history to avoid repetition. Only worth it for long-running recurring reminders.",
        },
        kind: {
          type: "string",
          description: "Optional tag for filtering: 'medication', 'chore', 'adhoc', etc.",
        },
      },
      required: ["name", "message"],
    },
  },
  {
    name: "schedule_compound_reminder",
    description:
      "Create a reminder with MULTIPLE items on different schedules that get bundled into one message when they fire together. Use for supplement stacks, medication regimens, or any 'group of things to remind about' with shared context. Example: 'daily supplements — Vitamin B12 at 8pm, Omega-3 at 9am and 9pm'. The sweep finds items whose schedules land in the same firing window and bundles them. Defaults to useLlm=true since LLM composition shines with multiple items.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Objective label, e.g. 'Daily supplements', 'Cristine post-op meds'.",
        },
        items: {
          type: "array",
          description: "List of items, each with its own schedule.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Item name, e.g. 'Vitamin B12', 'Oxycodone 5mg'." },
              notes: { type: "string", description: "Optional hints, e.g. 'take with food'." },
              firesAt: { type: "string", description: "ISO datetime for one-shot items." },
              rrule: { type: "string", description: "RRULE for recurring items." },
              startDate: { type: "string", description: "Optional ISO date — earliest allowed fire." },
              endDate: { type: "string", description: "Optional ISO date — latest allowed fire." },
            },
            required: ["name"],
          },
        },
        personName: {
          type: "string",
          description: "Optional — DM this person. Default: household group.",
        },
        useLlm: {
          type: "boolean",
          description: "Default true. Haiku composes the message from due items + recent history.",
        },
        kind: { type: "string" },
      },
      required: ["name", "items"],
    },
  },
  {
    name: "list_reminders",
    description:
      "List reminders with their next scheduled fire time. Filter by personName, kind, or status. Useful for answering 'what reminders do I have?' or 'what's Cristine's medication schedule?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        personName: { type: "string", description: "Filter to reminders DMing this person." },
        kind: { type: "string", description: "Filter by kind label (e.g. 'medication')." },
        includeExpired: { type: "boolean", description: "Default false — excludes EXPIRED and CANCELLED." },
      },
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel a reminder. Prefer passing reminderId when known. If only given a description ('cancel my vitamin reminder'), use query to fuzzy-match against reminder names.",
    input_schema: {
      type: "object" as const,
      properties: {
        reminderId: { type: "string" },
        query: { type: "string", description: "Fuzzy-match against reminder name." },
      },
    },
  },
  {
    name: "pause_reminder",
    description:
      "Temporarily pause a reminder (e.g. 'pause my vitamins while I'm traveling'). Resume later with resume_reminder.",
    input_schema: {
      type: "object" as const,
      properties: {
        reminderId: { type: "string" },
        query: { type: "string" },
      },
    },
  },
  {
    name: "resume_reminder",
    description: "Resume a paused reminder. Next fire will be on the next schedule occurrence.",
    input_schema: {
      type: "object" as const,
      properties: {
        reminderId: { type: "string" },
        query: { type: "string" },
      },
    },
  },
  {
    name: "send_photos",
    description:
      "Find and send up to 5 photos to the user as image attachments. Use when the user asks to see/send photos. Filters: query (fuzzy matched against album names AND trip names — pick whichever matches better), fromDate, toDate (YYYY-MM-DD inclusive). Favorited photos are sent first (curated picks from the user), then filled with the most recent non-favorites. Returns the matching photos AND a deep link to the /photos page filtered to the same set so the user can see more.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Album or trip name (fuzzy matched, case insensitive). The tool tries albums first, then falls back to trips and looks up linked albums.",
        },
        fromDate: { type: "string", description: "Earliest takenAt, YYYY-MM-DD" },
        toDate: { type: "string", description: "Latest takenAt, YYYY-MM-DD" },
        limit: { type: "integer", description: "Max photos to send (default 5, capped at 5)" },
      },
    },
  },
  {
    name: "get_home_devices",
    description:
      "List Home Assistant devices (thermostats, locks, cameras, sensors, etc.) with their last known state. Filter by domain (climate, lock, cover, camera, sensor, switch, etc.) or area (room name). Without filters, returns all pinned devices. State is cached from the last sync (daily + on-demand). To control a device, use control_device with the entity_id from here.",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description:
            "HA domain filter, e.g. 'climate' for thermostats, 'lock' for door locks, 'cover' for garage, 'camera'. Omit to list all pinned devices.",
        },
        area: {
          type: "string",
          description: "Room/area name, case insensitive fuzzy match. Omit to include all areas.",
        },
        pinnedOnly: {
          type: "boolean",
          description: "If true (default), only return devices marked as pinned. Pass false to include everything in the cache.",
        },
      },
    },
  },
  {
    name: "get_weather_briefing",
    description:
      "Fetch current METAR + TAF for an airport via the FAA aviationweather.gov API. Default airport is KAUS (Austin). Auto-selects 'plain' mode for household questions ('what's the weather') and 'aviation' mode when the user is flying in the next 2 days or explicitly asks about flight conditions. Returns parsed METAR fields (temp, wind, visibility, flight rules) AND raw METAR/TAF strings. Pilot-useful: flightRules is one of VFR/MVFR/IFR/LIFR derived from ceiling and visibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        icao: {
          type: "string",
          description: "ICAO airport code (e.g. KAUS, KORD, KMDW). Defaults to KAUS if omitted.",
        },
        mode: {
          type: "string",
          enum: ["plain", "aviation", "auto"],
          description: "plain = household-friendly line. aviation = full METAR+TAF for flying. auto (default) picks based on upcoming flights in the calendar and trip legs.",
        },
      },
    },
  },
  {
    name: "list_documents",
    description:
      "List household documents with metadata (title, type, owner, issuer, expiration). Returns documentNumber as `<REDACTED>` — never returns actual document numbers or file links. Use this for answering questions like 'what documents do we have' or 'find the passport'. If the user wants the actual file or number, follow up with `request_document_download`.",
    input_schema: {
      type: "object" as const,
      properties: {
        ownerName: {
          type: "string",
          description: "Filter to documents owned by this person. Case-insensitive name match. Omit to include household-scope and all owners.",
        },
        type: {
          type: "string",
          enum: [
            "DRIVERS_LICENSE",
            "PASSPORT",
            "GREEN_CARD",
            "TSA_PRECHECK",
            "GLOBAL_ENTRY",
            "INSURANCE",
            "OTHER",
          ],
          description: "Filter to a specific document type.",
        },
        expiringWithinDays: {
          type: "integer",
          description: "If set, only return documents with expiresDate within the next N days.",
        },
      },
    },
  },
  {
    name: "get_document_expirations",
    description:
      "Shortcut for 'what's expiring'. Returns documents expiring within the given window (default 90 days), sorted ascending by expiration. Useful for proactive reminders. Metadata-only — no numbers or file links.",
    input_schema: {
      type: "object" as const,
      properties: {
        withinDays: {
          type: "integer",
          description: "Lookahead window in days. Default 90.",
        },
      },
    },
  },
  {
    name: "request_document_download",
    description:
      "Initiate a Duo-Push-gated document release. Looks up the requester by sender name, verifies they're enrolled in Duo, creates a pending challenge, and sends an ASYNC Duo push to their phone. Returns PUSH_SENT with a challengeId — you MUST then immediately call check_document_auth with that challengeId to poll for the result. Tell the user to approve the push on their phone while you wait. If the user isn't enrolled, returns DENIED with reason not_enrolled — guide them to /security to link their Duo username.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "The homeDocument.id of the document to release.",
        },
        senderName: {
          type: "string",
          description: "The name of the requester (must match a homePerson.name case-insensitively). Used to look up their Duo username from homePersonAuth.",
        },
      },
      required: ["documentId", "senderName"],
    },
  },
  {
    name: "check_document_auth",
    description:
      "Poll the Duo push approval status after request_document_download returned PUSH_SENT. If approved, delivers the document (30-min signed URL or number) via DM and returns DELIVERED. If still waiting, returns WAITING — call again after a few seconds. If denied, returns DENIED. The tool NEVER returns the URL or documentNumber in its result — delivery goes via DM only. The agent MUST NOT try to paste URLs or numbers in its response text.",
    input_schema: {
      type: "object" as const,
      properties: {
        challengeId: {
          type: "string",
          description: "The challenge ID returned by request_document_download.",
        },
        txid: {
          type: "string",
          description: "The Duo transaction ID returned by request_document_download.",
        },
      },
      required: ["challengeId", "txid"],
    },
  },
  {
    name: "control_device",
    description:
      "Control a Home Assistant device (lock/unlock, turn on/off, set temperature, open/close cover, etc.). Evaluates the device's sensitivity tier against the household's risk policy. LOW devices execute immediately. MEDIUM devices require the sender to be on home wifi. HIGH devices require Duo Push approval — if HIGH, this tool fires an async push and returns PUSH_SENT with a challengeId + txid. Call check_device_auth to poll for approval. Every attempt is logged to the homeDeviceAction audit table.",
    input_schema: {
      type: "object" as const,
      properties: {
        entityId: {
          type: "string",
          description:
            "The Home Assistant entity_id (e.g. 'lock.back_door', 'climate.living_room')",
        },
        service: {
          type: "string",
          description:
            "The HA service to call (e.g. 'lock', 'unlock', 'turn_on', 'turn_off', 'set_temperature', 'open_cover', 'close_cover', 'toggle')",
        },
        serviceData: {
          type: "object",
          description:
            "Optional service data (e.g. {temperature: 72} for climate). The entity_id is added automatically.",
        },
        senderName: {
          type: "string",
          description:
            "Name of the person requesting the action (for Duo lookup and audit logging)",
        },
      },
      required: ["entityId", "service", "senderName"],
    },
  },
  {
    name: "check_device_auth",
    description:
      "Poll the Duo push approval status after control_device returned PUSH_SENT. If approved, executes the HA service call and returns EXECUTED. If still waiting, returns WAITING — call again after a few seconds. If denied, returns DENIED.",
    input_schema: {
      type: "object" as const,
      properties: {
        challengeId: {
          type: "string",
          description: "The challenge ID returned by control_device.",
        },
        txid: {
          type: "string",
          description: "The Duo transaction ID returned by control_device.",
        },
      },
      required: ["challengeId", "txid"],
    },
  },
  {
    name: "manage_checklist",
    description:
      "Create, rename, delete, duplicate, or save-as-template a checklist. Checklists attach to entities (trip, event, bill, document, task). 'duplicate' copies all items (unchecked) to the same or a different entity. 'save_as_template' saves a copy as a reusable template. 'from_template' creates a checklist from an existing template.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "rename", "delete", "duplicate", "save_as_template", "from_template"],
        },
        entityType: {
          type: "string",
          enum: ["TRIP", "EVENT", "BILL", "DOCUMENT", "TASK", "TEMPLATE", "OTHER"],
          description: "Required for create/duplicate/from_template. The type of entity this checklist belongs to.",
        },
        entityId: {
          type: "string",
          description: "Required for create/duplicate/from_template. The ID of the entity this checklist belongs to.",
        },
        checklistId: {
          type: "string",
          description: "Required for rename/delete/duplicate/save_as_template. The source checklist ID.",
        },
        templateId: {
          type: "string",
          description: "Required for from_template. The template checklist ID to copy from.",
        },
        name: {
          type: "string",
          description: "Required for create/rename. The checklist name.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_checklist_items",
    description:
      "Add, toggle, rename, or remove items from a checklist. Supports BATCH operations: pass an array of 'items' to add/toggle/remove multiple items in one call (much faster than calling this tool once per item). Items can optionally belong to a section.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "toggle", "rename", "remove"],
        },
        checklistId: {
          type: "string",
          description: "The checklist to modify.",
        },
        // Single-item fields (backward compatible)
        itemId: {
          type: "string",
          description: "For toggle/rename/remove of a single item.",
        },
        text: {
          type: "string",
          description: "For add/rename of a single item.",
        },
        section: {
          type: "string",
          description: "Optional for add. Section heading (e.g. 'Clothes').",
        },
        // Batch field — preferred for adding multiple items at once
        items: {
          type: "array",
          description: "For batch add: array of {text, section?}. For batch toggle/remove: array of {itemId}. Use this instead of calling the tool once per item.",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              section: { type: "string" },
              itemId: { type: "string" },
            },
          },
        },
      },
      required: ["action", "checklistId"],
    },
  },
  {
    name: "list_checklists",
    description:
      "List checklists and their items for a given entity (or all entities of a type). Returns checklist names, item texts, and done status.",
    input_schema: {
      type: "object" as const,
      properties: {
        entityType: {
          type: "string",
          enum: ["TRIP", "EVENT", "BILL", "DOCUMENT", "TASK", "TEMPLATE", "OTHER"],
          description: "Optional. Filter by entity type. Use TEMPLATE to list saved templates.",
        },
        entityId: {
          type: "string",
          description: "Optional. If provided, returns checklists for this specific entity. If only entityType is given, returns all checklists of that type.",
        },
      },
    },
  },
  {
    name: "attach_file",
    description:
      "Create an attachment record linking an already-uploaded S3 object to a parent entity (trip, trip leg, event, task, or bill). Used after the WA bot uploads a file to the inbox, or after a web upload completes. The s3Key should be the full S3 key relative to the bucket root.",
    input_schema: {
      type: "object" as const,
      properties: {
        parentType: {
          type: "string",
          enum: ["TRIP", "TRIP_LEG", "RESERVATION", "EVENT", "TASK", "BILL"],
        },
        parentId: { type: "string" },
        s3Key: { type: "string" },
        filename: { type: "string" },
        contentType: { type: "string" },
        caption: { type: "string", description: "Human-readable label, e.g. 'Hotel Confirmation', 'Boarding Pass'. Inferred from the user's message." },
      },
      required: ["parentType", "parentId", "s3Key", "filename"],
    },
  },
  {
    name: "list_attachments",
    description:
      "List file attachments for a parent entity. Returns filename, caption, content type, and size for each. Use when the user asks 'what files are attached to the Chicago trip' or 'show me the boarding pass'.",
    input_schema: {
      type: "object" as const,
      properties: {
        parentType: {
          type: "string",
          enum: ["TRIP", "TRIP_LEG", "RESERVATION", "EVENT", "TASK", "BILL"],
          description: "Optional filter by parent type.",
        },
        parentId: {
          type: "string",
          description: "The ID of the parent entity to list attachments for.",
        },
      },
      required: ["parentId"],
    },
  },
];

// ── Shopping list resolution ─────────────────────────────────────────────────

async function resolveShoppingList(listName?: string | null, includeArchived = false) {
  const client = await getDataClient();
  const { data: lists } = await client.models.homeShoppingList.list();
  const all = (lists ?? []).filter((l) => includeArchived || !l.isArchived);
  if (all.length === 0) return null;
  if (!listName) {
    // Default: prefer one called "Supermarket"/"Grocery", else the first by sortOrder
    const supermarket = all.find((l) => l.name.toLowerCase().includes("supermarket") || l.name.toLowerCase().includes("grocer"));
    if (supermarket) return supermarket;
    return [...all].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
  }
  const q = listName.toLowerCase().trim();
  // Exact match first, then contains
  return (
    all.find((l) => l.name.toLowerCase() === q) ??
    all.find((l) => l.name.toLowerCase().includes(q)) ??
    all.find((l) => q.includes(l.name.toLowerCase())) ??
    null
  );
}

// ── Tool execution ───────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getNextOccurrence(rruleString: string, after: Date): Date | null {
  try {
    const rule = RRule.fromString(rruleString);
    return rule.after(after);
  } catch {
    return null;
  }
}

// ── Reminder helpers ────────────────────────────────────────────────────────
// Shared between the schedule_reminder / schedule_compound_reminder /
// resume_reminder tool cases. Kept consistent with the sweep Lambda's
// own occurrence computation — see amplify/functions/reminder-sweep/handler.ts.

/**
 * Compute the first occurrence for a newly-created reminder item,
 * strictly in the future (after "now"). Returns null if the item has
 * no computable occurrence.
 */
function computeFirstOccurrence(item: Record<string, any>): Date | null {
  const now = new Date();
  if (item.firesAt) {
    const t = new Date(item.firesAt);
    if (!Number.isFinite(t.getTime())) return null;
    if (t <= now) return null;
    return t;
  }
  if (item.rrule) {
    try {
      const rule = RRule.fromString(item.rrule);
      const start = item.startDate ? new Date(item.startDate) : now;
      const searchFrom = start > now ? start : now;
      return rule.after(searchFrom, false) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Compute the next occurrence for an item strictly after `after`.
 * Handles both one-shot (firesAt) and recurring (rrule) items.
 */
/**
 * Normalize a homeReminder.items blob — may arrive as an array (if the
 * data client deserialized the AWSJSON) or as a raw JSON string. Tolerate
 * both. Same helper exists in the sweep lambda; duplicated here because
 * we don't cross-import between function bundles.
 */
function parseReminderItems(raw: unknown): Record<string, any>[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as Record<string, any>[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function computeNextOccurrenceAfter(
  item: Record<string, any>,
  after: Date
): Date | null {
  if (item.firesAt) {
    const t = new Date(item.firesAt);
    if (!Number.isFinite(t.getTime())) return null;
    if (t <= after) return null;
    return t;
  }
  if (item.rrule) {
    try {
      const rule = RRule.fromString(item.rrule);
      return rule.after(after, false) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve a reminder's target. If personName is given AND resolvable to
 * a known person, return PERSON target. Otherwise fall back to GROUP —
 * matching the user's directive of "default to group, we're an open page".
 */
async function resolveReminderTarget(
  personName: string | null | undefined
): Promise<{ targetKind: "PERSON" | "GROUP"; personId: string | null }> {
  if (!personName) return { targetKind: "GROUP", personId: null };
  const ids = await resolvePersonIds([personName]);
  if (ids.length === 1) return { targetKind: "PERSON", personId: ids[0] };
  return { targetKind: "GROUP", personId: null };
}

/**
 * Look up a reminder either by id or by fuzzy-matching its name. Used by
 * cancel_reminder / pause_reminder / resume_reminder tools.
 */
async function findReminder(
  input: { reminderId?: string; query?: string }
): Promise<Schema["homeReminder"]["type"] | null> {
  const c = await getDataClient();
  if (input.reminderId) {
    const { data } = await c.models.homeReminder.get({ id: input.reminderId });
    return data ?? null;
  }
  if (!input.query) return null;
  const { data: all } = await c.models.homeReminder.list({ limit: 200 });
  const q = input.query.toLowerCase();
  const active = (all ?? []).filter(
    (r) => r.status === "PENDING" || r.status === "PAUSED"
  );
  // Prefer exact name match, fall back to substring
  const exact = active.find((r) => r.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = active.find((r) => r.name.toLowerCase().includes(q));
  return partial ?? null;
}

// Attachments accumulated during a single agent invocation. Tools push
// to this and the handler returns it on the response.
interface Attachment {
  type: "image";
  url: string;
  caption?: string | null;
}

// Chat context passed in by invokeHomeAgent's chatContext arg. Lets
// tools know whether the request originated from a group chat (where
// sensitive payloads must be redirected to DM) vs. a DM or the web UI.
export type AgentChannel = "WA_GROUP" | "WA_DM" | "WEB";
export interface ChatContext {
  channel: AgentChannel;
  chatJid: string | null;
}

interface ToolContext {
  attachments: Attachment[];
  chatContext: ChatContext;
  sender: string;
}

async function executeTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  const client = await getDataClient();

  switch (name) {
    case "create_task": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeTask.create({
        title: input.title,
        description: input.description ?? null,
        assignedPersonIds,
        dueDate: input.dueDate ?? null,
        isCompleted: false,
        recurrence: input.recurrence ?? null,
        createdBy: "agent",
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, taskId: data?.id, title: input.title });
    }

    case "complete_task": {
      // Fetch the task to check for recurrence
      const { data: task } = await client.models.homeTask.get({ id: input.taskId });
      if (!task) return JSON.stringify({ error: "Task not found" });

      await client.models.homeTask.update({
        id: input.taskId,
        isCompleted: true,
        completedAt: new Date().toISOString(),
      });

      // If recurring, create the next occurrence
      let nextTaskId: string | null = null;
      if (task.recurrence) {
        const nextDate = getNextOccurrence(task.recurrence, new Date());
        if (nextDate) {
          const { data: nextTask } = await client.models.homeTask.create({
            title: task.title,
            description: task.description ?? null,
            assignedPersonIds: (task.assignedPersonIds ?? []).filter((id): id is string => !!id),
            dueDate: nextDate.toISOString(),
            isCompleted: false,
            recurrence: task.recurrence,
            createdBy: "recurrence",
          });
          nextTaskId = nextTask?.id ?? null;
        }
      }

      return JSON.stringify({
        success: true,
        taskId: input.taskId,
        nextTaskId,
      });
    }

    case "update_task": {
      const updates: { id: string } & Record<string, any> = { id: input.taskId };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description || null;
      if (input.assignedPeople !== undefined) {
        updates.assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      }
      if (input.dueDate !== undefined) updates.dueDate = input.dueDate || null;
      if (input.recurrence !== undefined) updates.recurrence = input.recurrence || null;
      const { data, errors } = await client.models.homeTask.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, taskId: data?.id, title: data?.title });
    }

    case "list_tasks": {
      const { data: tasks } = await client.models.homeTask.list({
        filter: { isCompleted: { eq: false } },
      });
      let filtered = tasks ?? [];
      if (input.person) {
        const personIds = await resolvePersonIds([input.person]);
        if (personIds.length > 0) {
          filtered = filtered.filter((t) => {
            const assigned = (t.assignedPersonIds ?? []).filter((id): id is string => !!id);
            return assigned.length === 0 || assigned.some((id) => personIds.includes(id));
          });
        }
      }
      return JSON.stringify({ tasks: filtered });
    }

    case "create_bill": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeBill.create({
        name: input.name,
        amount: input.amount ?? null,
        currency: input.currency ?? "USD",
        dueDay: input.dueDay ?? null,
        dueDate: input.dueDate ?? null,
        isRecurring: input.isRecurring ?? true,
        isPaid: false,
        category: input.category ?? null,
        url: input.url ?? null,
        notes: input.notes ?? null,
        assignedPersonIds,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, billId: data?.id, name: input.name });
    }

    case "mark_bill_paid": {
      await client.models.homeBill.update({
        id: input.billId,
        isPaid: true,
        paidAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, billId: input.billId });
    }

    case "list_bills": {
      const { data: bills } = await client.models.homeBill.list({
        filter: { isPaid: { eq: false } },
      });
      return JSON.stringify({ bills: bills ?? [] });
    }

    case "create_event": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeCalendarEvent.create({
        title: input.title,
        description: input.description ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        isAllDay: input.isAllDay ?? false,
        assignedPersonIds,
        recurrence: input.recurrence ?? null,
        location: input.location ?? null,
        reminderMinutes: input.reminderMinutes ?? null,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, eventId: data?.id, title: input.title });
    }

    case "update_event": {
      const updates: { id: string } & Record<string, any> = { id: input.eventId };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description || null;
      if (input.startAt !== undefined) updates.startAt = input.startAt;
      if (input.endAt !== undefined) updates.endAt = input.endAt || null;
      if (input.isAllDay !== undefined) updates.isAllDay = input.isAllDay;
      if (input.assignedPeople !== undefined) {
        updates.assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      }
      if (input.recurrence !== undefined) updates.recurrence = input.recurrence || null;
      if (input.location !== undefined) updates.location = input.location || null;
      if (input.url !== undefined) updates.url = input.url || null;
      if (input.reminderMinutes !== undefined) updates.reminderMinutes = input.reminderMinutes;
      if (input.tripId !== undefined) updates.tripId = input.tripId || null;
      const { data, errors } = await client.models.homeCalendarEvent.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, eventId: data?.id, title: data?.title });
    }

    case "list_calendar_events": {
      const { data: events } = await client.models.homeCalendarEvent.list();
      let filtered = events ?? [];

      // Default startDate to today (local CT) if not provided so we don't
      // dump every past event into the model context. Use the same TZ as
      // the system prompt so weekday-relative reasoning lines up.
      const startBound =
        input.startDate ??
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
      filtered = filtered.filter((e) => e.startAt && e.startAt >= startBound);

      if (input.endDate) {
        filtered = filtered.filter((e) => e.startAt && e.startAt < input.endDate);
      }

      if (input.person) {
        const personIds = await resolvePersonIds([input.person]);
        if (personIds.length > 0) {
          filtered = filtered.filter((e) => {
            const assigned = (e.assignedPersonIds ?? []).filter((id): id is string => !!id);
            return assigned.length === 0 || assigned.some((id) => personIds.includes(id));
          });
        }
      }

      filtered.sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
      return JSON.stringify({ events: filtered });
    }

    case "list_trips": {
      const { data: trips } = await client.models.homeTrip.list();
      let filtered = trips ?? [];

      if (!input.includePast) {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
          new Date()
        );
        filtered = filtered.filter((t) => t.endDate && t.endDate >= today);
      }

      filtered.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));

      // Fetch transportation legs for each trip in parallel and inline them.
      const tripsWithLegs = await Promise.all(
        filtered.map(async (trip) => {
          const { data: legs } = await client.models.homeTripLeg.list({
            filter: { tripId: { eq: trip.id } },
          });
          const sortedLegs = (legs ?? []).sort((a, b) => {
            const orderA = a.sortOrder ?? 0;
            const orderB = b.sortOrder ?? 0;
            if (orderA !== orderB) return orderA - orderB;
            return (a.departAt ?? "").localeCompare(b.departAt ?? "");
          });
          return { ...trip, legs: sortedLegs };
        })
      );

      return JSON.stringify({ trips: tripsWithLegs });
    }

    case "delete_event": {
      const { errors } = await client.models.homeCalendarEvent.delete({ id: input.eventId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, eventId: input.eventId });
    }

    case "create_trip": {
      const participantIds = await resolvePersonIds(input.participants);
      const { data, errors } = await client.models.homeTrip.create({
        name: input.name,
        type: input.type ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        destination: input.destination ?? null,
        notes: input.notes ?? null,
        participantIds,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, tripId: data?.id, name: input.name });
    }

    case "update_trip": {
      const updates: { id: string } & Record<string, any> = { id: input.tripId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.type !== undefined) updates.type = input.type;
      if (input.startDate !== undefined) updates.startDate = input.startDate;
      if (input.endDate !== undefined) updates.endDate = input.endDate;
      if (input.destination !== undefined) updates.destination = input.destination || null;
      if (input.notes !== undefined) updates.notes = input.notes || null;
      if (input.participants !== undefined) {
        updates.participantIds = await resolvePersonIds(input.participants);
      }
      const { data, errors } = await client.models.homeTrip.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, tripId: data?.id, name: data?.name });
    }

    case "delete_trip": {
      // Cascade-delete the trip's legs and reservations first (they are
      // keyed by tripId).
      const { data: legs } = await client.models.homeTripLeg.list({
        filter: { tripId: { eq: input.tripId } },
      });
      let legsDeleted = 0;
      for (const leg of legs ?? []) {
        await client.models.homeTripLeg.delete({ id: leg.id });
        legsDeleted++;
      }
      const { data: reservations } = await client.models.homeTripReservation.list({
        filter: { tripId: { eq: input.tripId } },
      });
      let reservationsDeleted = 0;
      for (const r of reservations ?? []) {
        await client.models.homeTripReservation.delete({ id: r.id });
        reservationsDeleted++;
      }
      const { errors } = await client.models.homeTrip.delete({ id: input.tripId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        tripId: input.tripId,
        legsDeleted,
        reservationsDeleted,
      });
    }

    case "create_trip_leg": {
      const { data, errors } = await client.models.homeTripLeg.create({
        tripId: input.tripId,
        mode: input.mode ?? null,
        departAt: input.departAt ?? null,
        arriveAt: input.arriveAt ?? null,
        fromLocation: input.fromLocation ?? null,
        toLocation: input.toLocation ?? null,
        confirmationCode: input.confirmationCode ?? null,
        url: input.url ?? null,
        notes: input.notes ?? null,
        airline: input.airline ?? null,
        flightNumber: input.flightNumber ?? null,
        aircraft: input.aircraft ?? null,
        sortOrder: input.sortOrder ?? 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, legId: data?.id, tripId: input.tripId });
    }

    case "update_trip_leg": {
      const updates: { id: string } & Record<string, any> = { id: input.legId };
      if (input.mode !== undefined) updates.mode = input.mode;
      if (input.departAt !== undefined) updates.departAt = input.departAt || null;
      if (input.arriveAt !== undefined) updates.arriveAt = input.arriveAt || null;
      if (input.fromLocation !== undefined) updates.fromLocation = input.fromLocation || null;
      if (input.toLocation !== undefined) updates.toLocation = input.toLocation || null;
      if (input.confirmationCode !== undefined)
        updates.confirmationCode = input.confirmationCode || null;
      if (input.url !== undefined) updates.url = input.url || null;
      if (input.notes !== undefined) updates.notes = input.notes || null;
      if (input.airline !== undefined) updates.airline = input.airline || null;
      if (input.flightNumber !== undefined) updates.flightNumber = input.flightNumber || null;
      if (input.aircraft !== undefined) updates.aircraft = input.aircraft || null;
      if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
      const { data, errors } = await client.models.homeTripLeg.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, legId: data?.id });
    }

    case "delete_trip_leg": {
      const { errors } = await client.models.homeTripLeg.delete({ id: input.legId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, legId: input.legId });
    }

    case "list_trip_legs": {
      const { data: legs } = await client.models.homeTripLeg.list({
        filter: { tripId: { eq: input.tripId } },
      });
      const sorted = (legs ?? []).sort((a, b) => {
        const orderA = a.sortOrder ?? 0;
        const orderB = b.sortOrder ?? 0;
        if (orderA !== orderB) return orderA - orderB;
        return (a.departAt ?? "").localeCompare(b.departAt ?? "");
      });
      return JSON.stringify({ legs: sorted });
    }

    case "create_trip_reservation": {
      const { data, errors } = await client.models.homeTripReservation.create({
        tripId: input.tripId,
        type: input.type ?? null,
        name: input.name,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        location: input.location ?? null,
        confirmationCode: input.confirmationCode ?? null,
        url: input.url ?? null,
        cost: input.cost ?? null,
        currency: input.currency ?? null,
        notes: input.notes ?? null,
        sortOrder: input.sortOrder ?? 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        reservationId: data?.id,
        tripId: input.tripId,
      });
    }

    case "update_trip_reservation": {
      const updates: { id: string } & Record<string, any> = { id: input.reservationId };
      if (input.type !== undefined) updates.type = input.type;
      if (input.name !== undefined) updates.name = input.name;
      if (input.startAt !== undefined) updates.startAt = input.startAt || null;
      if (input.endAt !== undefined) updates.endAt = input.endAt || null;
      if (input.location !== undefined) updates.location = input.location || null;
      if (input.confirmationCode !== undefined)
        updates.confirmationCode = input.confirmationCode || null;
      if (input.url !== undefined) updates.url = input.url || null;
      if (input.cost !== undefined) updates.cost = input.cost;
      if (input.currency !== undefined) updates.currency = input.currency || null;
      if (input.notes !== undefined) updates.notes = input.notes || null;
      if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
      const { data, errors } = await client.models.homeTripReservation.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, reservationId: data?.id });
    }

    case "delete_trip_reservation": {
      const { errors } = await client.models.homeTripReservation.delete({
        id: input.reservationId,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, reservationId: input.reservationId });
    }

    case "list_trip_reservations": {
      const { data: reservations } = await client.models.homeTripReservation.list({
        filter: { tripId: { eq: input.tripId } },
      });
      const sorted = (reservations ?? []).sort((a, b) => {
        const orderA = a.sortOrder ?? 0;
        const orderB = b.sortOrder ?? 0;
        if (orderA !== orderB) return orderA - orderB;
        return (a.startAt ?? "").localeCompare(b.startAt ?? "");
      });
      return JSON.stringify({ reservations: sorted });
    }

    case "set_calendar_day": {
      const personIds = await resolvePersonIds([input.person]);
      if (personIds.length === 0) {
        return JSON.stringify({ error: `No person matching "${input.person}"` });
      }
      const personId = personIds[0];
      // Find an existing row for (date, personId). Filter on date first
      // (secondary index) then match personId client-side.
      const { data: existingRows } = await client.models.homeCalendarDay.list({
        filter: { date: { eq: input.date } },
      });
      const existing = (existingRows ?? []).find((r) => r.personId === personId);

      const payload: Record<string, any> = {
        date: input.date,
        personId,
      };
      if (input.status !== undefined) payload.status = input.status;
      if (input.timezone !== undefined) payload.timezone = input.timezone || null;
      if (input.location !== undefined) payload.location = input.location || null;
      if (input.notes !== undefined) payload.notes = input.notes || null;
      if (input.ptoFraction !== undefined) payload.ptoFraction = input.ptoFraction;
      if (input.tripId !== undefined) payload.tripId = input.tripId || null;

      if (existing) {
        const { data, errors } = await client.models.homeCalendarDay.update({
          id: existing.id,
          ...payload,
        });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({
          success: true,
          action: "updated",
          dayId: data?.id,
          date: input.date,
          person: input.person,
        });
      }

      const { data, errors } = await client.models.homeCalendarDay.create({
        ...payload,
        ptoFraction: input.ptoFraction ?? 0,
      } as any);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        action: "created",
        dayId: data?.id,
        date: input.date,
        person: input.person,
      });
    }

    case "list_calendar_days": {
      const fromDate =
        input.fromDate ??
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
      const { data: days } = await client.models.homeCalendarDay.list({
        filter: { date: { ge: fromDate } },
      });
      let filtered = days ?? [];
      if (input.toDate) {
        filtered = filtered.filter((d) => d.date && d.date <= input.toDate);
      }
      if (input.person) {
        const personIds = await resolvePersonIds([input.person]);
        if (personIds.length > 0) {
          filtered = filtered.filter((d) => personIds.includes(d.personId));
        }
      }
      filtered.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
      return JSON.stringify({ days: filtered });
    }

    case "delete_task": {
      const { errors } = await client.models.homeTask.delete({ id: input.taskId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, taskId: input.taskId });
    }

    case "update_bill": {
      const updates: { id: string } & Record<string, any> = { id: input.billId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.amount !== undefined) updates.amount = input.amount;
      if (input.currency !== undefined) updates.currency = input.currency;
      if (input.dueDay !== undefined) updates.dueDay = input.dueDay;
      if (input.dueDate !== undefined) updates.dueDate = input.dueDate || null;
      if (input.isRecurring !== undefined) updates.isRecurring = input.isRecurring;
      if (input.category !== undefined) updates.category = input.category || null;
      if (input.url !== undefined) updates.url = input.url || null;
      if (input.notes !== undefined) updates.notes = input.notes || null;
      if (input.assignedPeople !== undefined) {
        updates.assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      }
      const { data, errors } = await client.models.homeBill.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, billId: data?.id, name: data?.name });
    }

    case "delete_bill": {
      const { errors } = await client.models.homeBill.delete({ id: input.billId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, billId: input.billId });
    }

    case "list_shopping_lists": {
      const { data: lists } = await client.models.homeShoppingList.list();
      const filtered = (lists ?? []).filter((l) => input.includeArchived || !l.isArchived);
      const results = await Promise.all(
        filtered.map(async (l) => {
          const { data: items } = await client.models.homeShoppingItem.list({
            filter: { listId: { eq: l.id }, isChecked: { eq: false } },
          });
          return {
            id: l.id,
            name: l.name,
            emoji: l.emoji,
            isArchived: !!l.isArchived,
            uncheckedCount: (items ?? []).length,
          };
        })
      );
      return JSON.stringify({ lists: results });
    }

    case "archive_shopping_list": {
      const list = await resolveShoppingList(input.listName);
      if (!list) return JSON.stringify({ error: `No active list matching "${input.listName}"` });
      await client.models.homeShoppingList.update({
        id: list.id,
        isArchived: true,
        archivedAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, listId: list.id, name: list.name });
    }

    case "unarchive_shopping_list": {
      const list = await resolveShoppingList(input.listName, true);
      if (!list) return JSON.stringify({ error: `No list matching "${input.listName}"` });
      await client.models.homeShoppingList.update({
        id: list.id,
        isArchived: false,
        archivedAt: null,
      });
      return JSON.stringify({ success: true, listId: list.id, name: list.name });
    }

    case "create_shopping_list": {
      const { data, errors } = await client.models.homeShoppingList.create({
        name: input.name,
        emoji: input.emoji ?? null,
        sortOrder: 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, listId: data?.id, name: input.name });
    }

    case "add_shopping_item": {
      const list = await resolveShoppingList(input.listName);
      if (!list) {
        return JSON.stringify({
          error: input.listName
            ? `No shopping list matching "${input.listName}". Use create_shopping_list first.`
            : "No shopping lists exist. Use create_shopping_list first.",
        });
      }
      const { data, errors } = await client.models.homeShoppingItem.create({
        listId: list.id,
        name: input.name,
        quantity: input.quantity ?? null,
        notes: input.notes ?? null,
        isChecked: false,
        addedBy: "agent",
        sortOrder: 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        itemId: data?.id,
        name: input.name,
        listName: list.name,
      });
    }

    case "list_shopping_items": {
      if (input.listName) {
        const list = await resolveShoppingList(input.listName);
        if (!list) return JSON.stringify({ error: `No shopping list matching "${input.listName}"` });
        const { data: items } = await client.models.homeShoppingItem.list({
          filter: { listId: { eq: list.id }, isChecked: { eq: false } },
        });
        return JSON.stringify({ listName: list.name, items: items ?? [] });
      }
      const { data: items } = await client.models.homeShoppingItem.list({
        filter: { isChecked: { eq: false } },
      });
      return JSON.stringify({ items: items ?? [] });
    }

    case "check_shopping_item": {
      await client.models.homeShoppingItem.update({
        id: input.itemId,
        isChecked: true,
        checkedAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, itemId: input.itemId });
    }

    case "uncheck_shopping_item": {
      const { data, errors } = await client.models.homeShoppingItem.update({
        id: input.itemId,
        isChecked: false,
        checkedAt: null,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, itemId: data?.id });
    }

    case "update_shopping_list": {
      const updates: { id: string } & Record<string, any> = { id: input.listId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.emoji !== undefined) updates.emoji = input.emoji || null;
      if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
      const { data, errors } = await client.models.homeShoppingList.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, listId: data?.id, name: data?.name });
    }

    case "delete_shopping_list": {
      // Cascade-delete items first (they are keyed by listId).
      const { data: items } = await client.models.homeShoppingItem.list({
        filter: { listId: { eq: input.listId } },
      });
      let itemsDeleted = 0;
      for (const item of items ?? []) {
        await client.models.homeShoppingItem.delete({ id: item.id });
        itemsDeleted++;
      }
      const { errors } = await client.models.homeShoppingList.delete({ id: input.listId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, listId: input.listId, itemsDeleted });
    }

    case "update_shopping_item": {
      const updates: { id: string } & Record<string, any> = { id: input.itemId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.quantity !== undefined) updates.quantity = input.quantity || null;
      if (input.notes !== undefined) updates.notes = input.notes || null;
      if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
      const { data, errors } = await client.models.homeShoppingItem.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, itemId: data?.id, name: data?.name });
    }

    case "delete_shopping_item": {
      const { errors } = await client.models.homeShoppingItem.delete({ id: input.itemId });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, itemId: input.itemId });
    }

    case "send_photos": {
      const limit = Math.min(input.limit ?? 5, 5);

      // Resolve query → set of album IDs to match against
      let albumIds: string[] = [];
      let matchedLabel: string | null = null;
      if (input.query) {
        const q = String(input.query).toLowerCase().trim();

        // Try to match an album by name first
        const { data: albums } = await client.models.homeAlbum.list();
        const albumMatch =
          (albums ?? []).find((a) => a.name.toLowerCase() === q) ??
          (albums ?? []).find((a) => a.name.toLowerCase().includes(q)) ??
          (albums ?? []).find((a) => q.includes(a.name.toLowerCase()));

        if (albumMatch) {
          albumIds = [albumMatch.id];
          matchedLabel = albumMatch.name;
        } else {
          // Fall back to trip name → linked albums
          const { data: trips } = await client.models.homeTrip.list();
          const trip =
            (trips ?? []).find((t) => t.name.toLowerCase() === q) ??
            (trips ?? []).find((t) => t.name.toLowerCase().includes(q)) ??
            (trips ?? []).find((t) => q.includes(t.name.toLowerCase()));
          if (!trip) {
            return JSON.stringify({
              error: `No album or trip matching "${input.query}"`,
            });
          }
          // Find albums whose tripIds includes this trip
          const linked = (albums ?? []).filter((a) =>
            (a.tripIds ?? [])
              .filter((id): id is string => !!id)
              .includes(trip.id)
          );
          if (linked.length === 0) {
            return JSON.stringify({
              error: `Trip "${trip.name}" has no linked albums yet — create one first`,
            });
          }
          albumIds = linked.map((a) => a.id);
          matchedLabel = trip.name;
        }
      }

      // Get the photo IDs that belong to the matched albums (if any)
      let photoIdSet: Set<string> | null = null;
      if (albumIds.length > 0) {
        const allJoins: { photoId: string }[] = [];
        for (const albumId of albumIds) {
          const { data: joins } = await client.models.homeAlbumPhoto.list({
            filter: { albumId: { eq: albumId } },
            limit: 1000,
          });
          for (const j of joins ?? []) {
            allJoins.push({ photoId: j.photoId });
          }
        }
        photoIdSet = new Set(allJoins.map((j) => j.photoId));
      }

      // Build the date filter
      const filter: Record<string, any> = {};
      if (input.fromDate) {
        const from = new Date(input.fromDate).toISOString();
        filter.takenAt = { ...(filter.takenAt ?? {}), ge: from };
      }
      if (input.toDate) {
        const to = new Date(`${input.toDate}T23:59:59.999Z`).toISOString();
        filter.takenAt = { ...(filter.takenAt ?? {}), le: to };
      }

      const { data: photos } = await client.models.homePhoto.list({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit: 1000,
      });

      let candidates = photos ?? [];
      if (photoIdSet) {
        candidates = candidates.filter((p) => photoIdSet!.has(p.id));
      }

      // Sort newest first as the base order
      const byDateDesc = (a: typeof candidates[number], b: typeof candidates[number]) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      };

      // Prefer favorites: take all favorited photos (sorted newest first),
      // then fill the remaining slots with non-favorites (also newest first).
      // Example: 3 favorites + 10 total + limit 5 → 3 favorites + 2 newest others.
      const favorites = candidates.filter((p) => p.isFavorite).sort(byDateDesc);
      const others = candidates.filter((p) => !p.isFavorite).sort(byDateDesc);
      const sorted = [...favorites, ...others];

      const totalMatching = sorted.length;
      const selected = sorted.slice(0, limit);
      const favoritesSent = selected.filter((p) => p.isFavorite).length;

      // Build CloudFront URLs and add to attachments. Use JPEG (not WebP)
      // because WhatsApp clients can fail to download WebP inline images.
      const CLOUDFRONT = "https://d2vnnym2o6bm6m.cloudfront.net";
      function buildUrl(s3key: string, width = 1024, quality = 80): string {
        return `${CLOUDFRONT}/${s3key}?format=jpeg&width=${width}&quality=${quality}`;
      }

      // Build a deep link to /photos with the same filter
      const APP_URL = process.env.APP_URL ?? "https://home.cristinegennaro.com";
      const params = new URLSearchParams();
      if (albumIds.length === 1) params.set("album", albumIds[0]);
      if (input.fromDate) params.set("from", input.fromDate);
      if (input.toDate) params.set("to", input.toDate);
      const deepLink = `${APP_URL}/photos${params.toString() ? `?${params}` : ""}`;

      for (const p of selected) {
        const dateLabel = p.takenAt ? new Date(p.takenAt).toLocaleDateString() : "";
        const captionParts = [matchedLabel ?? "", dateLabel, p.originalFilename ?? ""].filter(Boolean);
        ctx.attachments.push({
          type: "image",
          url: buildUrl(p.s3key),
          caption: captionParts.join(" · ") || null,
        });
      }

      return JSON.stringify({
        success: true,
        sent: selected.length,
        favoritesSent,
        totalFavorites: favorites.length,
        totalMatching,
        deepLink,
        more: totalMatching > selected.length ? totalMatching - selected.length : 0,
      });
    }

    case "schedule_reminder": {
      // Single-item reminder. Internally stored as a compound reminder
      // with one item, to keep one code path in the sweep.
      const itemId = generateId();
      const item: Record<string, any> = {
        id: itemId,
        name: input.message,
      };
      if (input.firesAt) item.firesAt = input.firesAt;
      if (input.rrule) item.rrule = input.rrule;
      if (input.endDate) item.endDate = input.endDate;

      const firstOccurrence = computeFirstOccurrence(item);
      if (!firstOccurrence) {
        return JSON.stringify({
          error: "Couldn't compute a first occurrence. Check firesAt/rrule/endDate.",
        });
      }

      const { personId, targetKind } = await resolveReminderTarget(input.personName);

      const { data, errors } = await client.models.homeReminder.create({
        name: input.name,
        // a.json() must be pre-stringified at the AppSync wire level.
        items: JSON.stringify([item]) as any,
        useLlm: input.useLlm === true,
        targetKind,
        personId: personId ?? null,
        groupJid: null,
        scheduledAt: firstOccurrence.toISOString(),
        status: "PENDING",
        kind: input.kind ?? null,
        createdBy: ctx.sender,
      });
      if (errors?.length) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        reminderId: data?.id,
        name: input.name,
        firstFire: firstOccurrence.toISOString(),
      });
    }

    case "schedule_compound_reminder": {
      const inputItems = Array.isArray(input.items) ? input.items : [];
      if (inputItems.length === 0) {
        return JSON.stringify({ error: "items array is required and must be non-empty" });
      }

      const items = inputItems.map((i: any) => {
        const item: Record<string, any> = {
          id: generateId(),
          name: i.name,
        };
        if (i.notes) item.notes = i.notes;
        if (i.firesAt) item.firesAt = i.firesAt;
        if (i.rrule) item.rrule = i.rrule;
        if (i.startDate) item.startDate = i.startDate;
        if (i.endDate) item.endDate = i.endDate;
        return item;
      });

      // Compute earliest first occurrence across all items
      let earliest: Date | null = null;
      for (const item of items) {
        const first = computeFirstOccurrence(item);
        if (first && (!earliest || first < earliest)) earliest = first;
      }
      if (!earliest) {
        return JSON.stringify({
          error: "No items produced a valid first occurrence. Check schedules.",
        });
      }

      const { personId, targetKind } = await resolveReminderTarget(input.personName);

      const { data, errors } = await client.models.homeReminder.create({
        name: input.name,
        items: JSON.stringify(items) as any,
        useLlm: input.useLlm !== false, // default true for compound
        targetKind,
        personId: personId ?? null,
        groupJid: null,
        scheduledAt: earliest.toISOString(),
        status: "PENDING",
        kind: input.kind ?? null,
        createdBy: ctx.sender,
      });
      if (errors?.length) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        reminderId: data?.id,
        name: input.name,
        itemCount: items.length,
        firstFire: earliest.toISOString(),
      });
    }

    case "list_reminders": {
      const { data: all } = await client.models.homeReminder.list({ limit: 200 });
      let filtered = all ?? [];

      if (!input.includeExpired) {
        filtered = filtered.filter(
          (r) => r.status === "PENDING" || r.status === "PAUSED"
        );
      }
      if (input.kind) {
        filtered = filtered.filter((r) => r.kind === input.kind);
      }
      if (input.personName) {
        const ids = await resolvePersonIds([input.personName]);
        if (ids.length > 0) {
          filtered = filtered.filter((r) => ids.includes(r.personId ?? ""));
        }
      }

      return JSON.stringify({
        count: filtered.length,
        reminders: filtered.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          scheduledAt: r.scheduledAt,
          targetKind: r.targetKind,
          personId: r.personId,
          itemCount: parseReminderItems(r.items).length,
          kind: r.kind,
          useLlm: r.useLlm,
        })),
      });
    }

    case "cancel_reminder": {
      const reminder = await findReminder(input);
      if (!reminder) return JSON.stringify({ error: "Reminder not found" });
      await client.models.homeReminder.update({
        id: reminder.id,
        status: "CANCELLED",
      });
      return JSON.stringify({ success: true, reminderId: reminder.id, name: reminder.name });
    }

    case "pause_reminder": {
      const reminder = await findReminder(input);
      if (!reminder) return JSON.stringify({ error: "Reminder not found" });
      await client.models.homeReminder.update({
        id: reminder.id,
        status: "PAUSED",
      });
      return JSON.stringify({ success: true, reminderId: reminder.id, name: reminder.name });
    }

    case "resume_reminder": {
      const reminder = await findReminder(input);
      if (!reminder) return JSON.stringify({ error: "Reminder not found" });

      // Recompute scheduledAt from items — the pause might've been long
      // enough that the old scheduledAt is in the past.
      const items = parseReminderItems(reminder.items);
      const now = new Date();
      let earliest: Date | null = null;
      for (const item of items) {
        const next = computeNextOccurrenceAfter(item, now);
        if (next && (!earliest || next < earliest)) earliest = next;
      }
      if (!earliest) {
        return JSON.stringify({
          error: "Reminder has no more occurrences — cancel it instead.",
        });
      }
      await client.models.homeReminder.update({
        id: reminder.id,
        status: "PENDING",
        scheduledAt: earliest.toISOString(),
      });
      return JSON.stringify({
        success: true,
        reminderId: reminder.id,
        name: reminder.name,
        nextFire: earliest.toISOString(),
      });
    }

    case "get_home_devices": {
      const pinnedOnly = input.pinnedOnly !== false;
      const { data: devices } = await client.models.homeDevice.list({ limit: 500 });
      let filtered = devices ?? [];

      if (pinnedOnly) filtered = filtered.filter((d) => d.isPinned);
      if (input.domain) filtered = filtered.filter((d) => d.domain === input.domain);
      if (input.area) {
        const q = input.area.toLowerCase();
        filtered = filtered.filter((d) => d.area?.toLowerCase().includes(q));
      }

      // Shape the response for Claude — only fields it needs, no internal ids.
      // lastState is the HA state blob so Claude can interpret e.g. climate
      // attributes (current_temperature, temperature, hvac_mode) or lock
      // state strings ("locked"/"unlocked"). It's stored as a JSON string
      // (see hass-sync for why) so we parse it here before handing to Claude.
      const parseLastState = (raw: unknown): unknown => {
        if (raw == null) return null;
        if (typeof raw === "string") {
          try { return JSON.parse(raw); } catch { return null; }
        }
        return raw;
      };
      const shaped = filtered.map((d) => ({
        entityId: d.entityId,
        friendlyName: d.friendlyName,
        domain: d.domain,
        area: d.area,
        sensitivity: d.sensitivity,
        state: parseLastState(d.lastState),
        lastSyncedAt: d.lastSyncedAt,
      }));

      return JSON.stringify({
        devices: shaped,
        count: shaped.length,
        note:
          "Use control_device to actuate any device with a non-READ_ONLY sensitivity tier.",
      });
    }

    case "get_weather_briefing": {
      const icao = (input.icao ?? DEFAULT_ICAO).toUpperCase();
      const mode = input.mode ?? "auto";

      // If user explicitly asked for plain or aviation, skip the trip/
      // calendar scan — they've already made the choice. For "auto",
      // fetch the signals and let detectFlyingWindow decide.
      if (mode === "plain" || mode === "aviation") {
        const { metar, taf } = await fetchAirportWeather(icao);
        return JSON.stringify({
          icao,
          mode,
          metar,
          taf,
          flyingContext: { flying: mode === "aviation" },
          note:
            mode === "aviation"
              ? "Render as a pilot briefing: raw METAR, raw TAF, flight rules verdict."
              : "Render as a one-line plain-English weather summary.",
        });
      }

      // Auto mode: pull trip legs + upcoming events so the briefing
      // can decide plain vs aviation. Cap at modest limits — we only
      // care about the next 2 days.
      const [legsRes, eventsRes] = await Promise.all([
        client.models.homeTripLeg.list({ limit: 500 }),
        client.models.homeCalendarEvent.list({ limit: 500 }),
      ]);
      const briefing = await getMorningWeatherBriefing(icao, {
        tripLegs: (legsRes.data ?? []).map((l) => ({
          mode: l.mode,
          departAt: l.departAt,
        })),
        events: (eventsRes.data ?? []).map((e) => ({
          title: e.title,
          description: e.description,
          startAt: e.startAt,
        })),
        lookaheadDays: 2,
      });

      return JSON.stringify({
        icao: briefing.icao,
        mode: briefing.mode,
        metar: briefing.metar,
        taf: briefing.taf,
        flyingContext: briefing.flyingContext,
        note:
          briefing.mode === "aviation"
            ? `Auto-selected aviation mode: ${briefing.flyingContext.source} "${briefing.flyingContext.title}" at ${briefing.flyingContext.when}. Render as a pilot briefing.`
            : "Auto-selected plain mode (no flights detected in next 2 days). Render as a one-line summary.",
      });
    }

    // ── Document vault ───────────────────────────────────────────────
    case "list_documents": {
      const people = await getPeople();
      let ownerFilterIds: Set<string> | null = null;
      if (input.ownerName) {
        const q = (input.ownerName as string).toLowerCase();
        const matches = people.filter((p) => p.name.toLowerCase() === q);
        if (matches.length === 0) {
          return JSON.stringify({
            documents: [],
            note: `No person named "${input.ownerName}".`,
          });
        }
        ownerFilterIds = new Set(matches.map((p) => p.id));
      }

      const { data: docs } = await client.models.homeDocument.list({ limit: 500 });
      const now = Date.now();
      const cutoff =
        typeof input.expiringWithinDays === "number"
          ? now + input.expiringWithinDays * 24 * 60 * 60 * 1000
          : null;

      const personById = new Map(people.map((p) => [p.id, p.name] as const));
      const filtered = (docs ?? []).filter((d) => {
        if (input.type && d.type !== input.type) return false;
        if (ownerFilterIds && (!d.ownerPersonId || !ownerFilterIds.has(d.ownerPersonId))) {
          return false;
        }
        if (cutoff != null) {
          if (!d.expiresDate) return false;
          const exp = Date.parse(d.expiresDate as unknown as string);
          if (Number.isNaN(exp) || exp > cutoff) return false;
        }
        return true;
      });

      const shaped = filtered.map((d) => ({
        id: d.id,
        title: d.title,
        type: d.type,
        scope: d.scope,
        ownerName: d.ownerPersonId ? personById.get(d.ownerPersonId) ?? null : null,
        issuer: d.issuer ?? null,
        issuedDate: d.issuedDate ?? null,
        expiresDate: d.expiresDate ?? null,
        // Intentionally omit documentNumber, s3Key, contentType.
        documentNumber: "<REDACTED>",
        hasFile: !!d.s3Key,
      }));

      return JSON.stringify({
        documents: shaped,
        count: shaped.length,
        note:
          "Metadata only. To release a document number or file URL, use request_document_download (it requires Duo Push approval).",
      });
    }

    case "get_document_expirations": {
      const withinDays = typeof input.withinDays === "number" ? input.withinDays : 90;
      const { data: docs } = await client.models.homeDocument.list({ limit: 500 });
      const people = await getPeople();
      const personById = new Map(people.map((p) => [p.id, p.name] as const));

      const now = Date.now();
      const cutoff = now + withinDays * 24 * 60 * 60 * 1000;
      const matching: Array<{
        id: string;
        title: string;
        type: string | null;
        ownerName: string | null;
        expiresDate: string;
        daysUntilExpiry: number;
      }> = [];
      for (const d of docs ?? []) {
        if (!d.expiresDate) continue;
        const exp = Date.parse(d.expiresDate as unknown as string);
        if (Number.isNaN(exp)) continue;
        if (exp > cutoff) continue;
        matching.push({
          id: d.id,
          title: d.title,
          type: (d.type as string | null) ?? null,
          ownerName: d.ownerPersonId ? personById.get(d.ownerPersonId) ?? null : null,
          expiresDate: d.expiresDate as unknown as string,
          daysUntilExpiry: Math.round((exp - now) / (24 * 60 * 60 * 1000)),
        });
      }
      matching.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
      return JSON.stringify({ documents: matching, count: matching.length, withinDays });
    }

    case "request_document_download": {
      const documentId = input.documentId as string;
      const senderName = input.senderName as string;
      console.log("[doc-download] start:", { documentId, senderName });
      const channelForLog: "WA" | "WEB" =
        ctx.chatContext?.channel === "WEB" ? "WEB" : "WA";

      // 1. Fetch the document
      const { data: doc } = await client.models.homeDocument.get({ id: documentId });
      if (!doc) {
        return JSON.stringify({ status: "ERROR", reason: "document_not_found" });
      }

      // 2. Resolve the requester → homePerson → homePersonAuth
      const people = await getPeople();
      const requester = people.find(
        (p) => p.name.toLowerCase() === senderName.toLowerCase()
      );
      if (!requester) {
        return JSON.stringify({
          status: "ERROR",
          reason: `No household member named "${senderName}"`,
        });
      }
      const ownerPerson = doc.ownerPersonId
        ? people.find((p) => p.id === doc.ownerPersonId) ?? null
        : null;

      const { data: auths } = await client.models.homePersonAuth.list({
        filter: { personId: { eq: requester.id } },
        limit: 10,
      });
      const auth = (auths ?? [])[0];
      if (!auth?.duoUsername) {
        await client.models.homeDocumentAccessLog.create({
          documentId,
          personId: requester.id,
          channel: channelForLog,
          action: "DOWNLOAD_REQUEST",
          result: "DENIED",
          error: "not_enrolled",
        });
        return JSON.stringify({
          status: "DENIED",
          reason: "not_enrolled",
          note: `${requester.name} has not linked a Duo account. Have them visit /security.`,
        });
      }

      // 3. Preauth
      let preauthRes;
      try {
        preauthRes = await duoPreauth(auth.duoUsername);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await client.models.homeDocumentAccessLog.create({
          documentId,
          personId: requester.id,
          channel: channelForLog,
          action: "DOWNLOAD_REQUEST",
          result: "FAILED",
          error: `preauth: ${msg}`.slice(0, 500),
        });
        console.error("[doc-download] preauth failed:", msg);
        return JSON.stringify({ status: "ERROR", reason: `preauth_failed: ${msg}` });
      }

      if (preauthRes.result === "deny") {
        await client.models.homeDocumentAccessLog.create({
          documentId,
          personId: requester.id,
          channel: channelForLog,
          action: "AUTH_DENIED",
          result: "DENIED",
          error: `preauth_deny: ${preauthRes.status_msg ?? ""}`.slice(0, 500),
        });
        console.error("[doc-download] preauth deny:", preauthRes.status_msg);
        return JSON.stringify({ status: "DENIED", reason: "locked_out" });
      }
      if (preauthRes.result === "enroll") {
        await client.models.homeDocumentAccessLog.create({
          documentId,
          personId: requester.id,
          channel: channelForLog,
          action: "DOWNLOAD_REQUEST",
          result: "DENIED",
          error: "preauth_enroll",
        });
        return JSON.stringify({ status: "DENIED", reason: "not_enrolled" });
      }

      // 4. Write pending challenge row BEFORE the push (audit trail if
      //    the Lambda dies mid-push).
      const conversationKey =
        ctx.chatContext?.chatJid != null
          ? `wa:${ctx.chatContext.chatJid}`
          : `web:${requester.id}:${Date.now()}`;
      const challengeExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { data: challenge } = await client.models.homePendingAuthChallenge.create({
        conversationKey,
        personId: requester.id,
        documentId,
        attemptsRemaining: 1,
        expiresAt: challengeExpiresAt,
      });

      // 5. Fire Duo push ASYNC (non-blocking — returns a txid immediately).
      //    Store the txid on the challenge row so check_document_auth can
      //    poll for the result in a separate tool call. This avoids the 30s
      //    AppSync resolver timeout that killed the synchronous push.
      if (preauthRes.result === "auth") {
        try {
          const res = await duoPushAuth({
            username: auth.duoUsername,
            pushinfo: {
              Document: doc.title ?? "(untitled)",
              "Requested by": requester.name,
              Channel: channelForLog,
            },
            type: "Document vault",
            displayUsername: auth.duoUsername,
            async: "1",
          });
          // Store the txid on the challenge row for polling
          if (challenge?.id && res.txid) {
            await client.models.homePendingAuthChallenge.update({
              id: challenge.id,
              conversationKey: `${conversationKey}:txid:${res.txid}`,
            });
          }
          console.log("[doc-download] push sent, txid:", res.txid, "challengeId:", challenge?.id);
          return JSON.stringify({
            status: "PUSH_SENT",
            challengeId: challenge?.id,
            txid: res.txid,
            message: "Duo push sent to the user's phone. Call check_document_auth with the challengeId to poll for approval. Tell the user to approve the push on their phone.",
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (challenge?.id) {
            await client.models.homePendingAuthChallenge.delete({ id: challenge.id });
          }
          await client.models.homeDocumentAccessLog.create({
            documentId,
            personId: requester.id,
            channel: channelForLog,
            action: "DOWNLOAD_REQUEST",
            result: "FAILED",
            error: `push: ${msg}`.slice(0, 500),
          });
          console.error("[doc-download] push failed:", msg);
          return JSON.stringify({
            status: "ERROR",
            reason: `push_failed: ${msg}`,
          });
        }
      }

      // Pre-approved mode ("allow" result from preauth — rare).
      // Skip push entirely and fall through to payload generation.

      // 6. Push approved — log and generate payload
      await client.models.homeDocumentAccessLog.create({
        documentId,
        personId: requester.id,
        channel: channelForLog,
        action: "AUTH_APPROVED",
        result: "SUCCESS",
      });

      // 7. Build payload — either a CloudFront URL (file-backed) or the
      //    raw documentNumber (metadata-only entries like Global Entry).
      //    CloudFront serves the entire S3 bucket; the UUID in the key is
      //    the effective unguessability gate (same security model as photos).
      let dmText = "";
      let deliveryKind: "file" | "number" = "number";
      if (doc.s3Key) {
        // Direct S3 URL — the bucket allows public reads on home/* and
        // the UUID in the key is the unguessability gate (same model as
        // photos). Presigned URLs failed due to bucket policy conflicts.
        // Short URL via /api/d/[key] redirector — keeps WA links under
        // ~80 chars so iOS doesn't truncate them. The redirector maps
        // the filename back to home/documents/{key} and 302s to S3.
        const docFilename = doc.s3Key.replace("home/documents/", "");
        const url = `https://home.cristinegennaro.com/api/d/${docFilename}`;
        dmText = `Here's your document: ${doc.title}\n${url}`;
        deliveryKind = "file";
      } else if (doc.documentNumber) {
        dmText = `${doc.title}: ${doc.documentNumber}`;
        deliveryKind = "number";
      } else {
        return JSON.stringify({
          status: "ERROR",
          reason: "Document has no s3Key and no documentNumber to release",
        });
      }

      // 8. Deliver via PERSON-target homeOutboundMessage. The WA bot's
      //    outbound poller resolves personId → phoneNumber and DMs it.
      //    This is the critical security gate: URLs/numbers NEVER go
      //    back to Claude in the tool result, only to the WA DM.
      await client.models.homeOutboundMessage.create({
        channel: "WHATSAPP",
        target: "PERSON",
        personId: requester.id,
        text: dmText,
        status: "PENDING",
        kind: "document_release",
      });

      // 9. LINK_ISSUED access log + lastUsedAt bump
      await client.models.homeDocumentAccessLog.create({
        documentId,
        personId: requester.id,
        channel: channelForLog,
        action: "LINK_ISSUED",
        result: "SUCCESS",
      });
      await client.models.homePersonAuth.update({
        id: auth.id,
        lastUsedAt: new Date().toISOString(),
      });

      // 10. Optional transparency DM to the owner (feature-flag gated).
      //     Only fires for PERSONAL-scope docs when the requester isn't
      //     the owner. Disabled by default; flip the flag in lib/feature-flags.ts.
      if (
        DOCUMENT_ACCESS_NOTIFICATIONS_ENABLED &&
        doc.scope === "PERSONAL" &&
        doc.ownerPersonId &&
        doc.ownerPersonId !== requester.id &&
        ownerPerson
      ) {
        const docTypeLabel = doc.type
          ? (doc.type as string).toLowerCase().replace(/_/g, " ")
          : "document";
        await client.models.homeOutboundMessage.create({
          channel: "WHATSAPP",
          target: "PERSON",
          personId: doc.ownerPersonId,
          text: `Heads up: ${requester.name} just accessed your ${docTypeLabel}: '${doc.title}'. If this wasn't expected, let Gennaro know.`,
          status: "PENDING",
          kind: "document_access_notification",
        });
      }

      // 11. Clean up the challenge row (done)
      if (challenge?.id) {
        await client.models.homePendingAuthChallenge.delete({ id: challenge.id });
      }

      // 12. Sanitized result to the agent. No URL, no number — the DM
      //     is on its way via the outbound poller. Claude should say
      //     something like "Sent to your DM".
      return JSON.stringify({
        status: "DELIVERED",
        deliveredVia: "DM",
        deliveryKind,
        documentTitle: doc.title,
        ownerName: ownerPerson?.name ?? null,
      });
    }

    // ── check_document_auth ──────────────────────────────────────────────
    case "check_document_auth": {
      const { challengeId, txid } = input as { challengeId: string; txid: string };
      if (!challengeId || !txid) {
        return JSON.stringify({ status: "ERROR", reason: "challengeId and txid are required" });
      }

      // 1. Poll Duo for the push result (instant — no blocking)
      let pollResult: Awaited<ReturnType<typeof duoAuthStatus>>;
      try {
        pollResult = await duoAuthStatus(txid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ status: "ERROR", reason: `duo_poll_failed: ${msg}` });
      }

      if (pollResult.result === "waiting") {
        return JSON.stringify({
          status: "WAITING",
          message: "User hasn't responded to the Duo push yet. Call check_document_auth again in a few seconds.",
        });
      }

      // 2. Fetch the challenge row to get document + requester info
      const { data: ch } = await client.models.homePendingAuthChallenge.get({ id: challengeId });
      if (!ch) {
        return JSON.stringify({ status: "ERROR", reason: "Challenge not found or expired" });
      }

      const channelForLog = ctx.chatContext?.channel === "WA_DM" || ctx.chatContext?.channel === "WA_GROUP" ? "WA" : "WEB";

      if (pollResult.result === "deny") {
        await client.models.homePendingAuthChallenge.delete({ id: challengeId });
        await client.models.homeDocumentAccessLog.create({
          documentId: ch.documentId,
          personId: ch.personId,
          channel: channelForLog,
          action: "AUTH_DENIED",
          result: "DENIED",
          error: "user_denied_or_timeout",
        });
        return JSON.stringify({ status: "DENIED", reason: "user_denied" });
      }

      // 3. Approved — fetch document, generate payload, deliver via DM
      await client.models.homeDocumentAccessLog.create({
        documentId: ch.documentId,
        personId: ch.personId,
        channel: channelForLog,
        action: "AUTH_APPROVED",
        result: "SUCCESS",
      });

      const { data: doc } = await client.models.homeDocument.get({ id: ch.documentId });
      if (!doc) {
        await client.models.homePendingAuthChallenge.delete({ id: challengeId });
        return JSON.stringify({ status: "ERROR", reason: "Document not found" });
      }

      let dmText = "";
      let deliveryKind: "file" | "number" = "number";
      if (doc.s3Key) {
        // Short URL via /api/d/[key] redirector — keeps WA links under
        // ~80 chars so iOS doesn't truncate them. The redirector maps
        // the filename back to home/documents/{key} and 302s to S3.
        const docFilename = doc.s3Key.replace("home/documents/", "");
        const url = `https://home.cristinegennaro.com/api/d/${docFilename}`;
        dmText = `Here's your document: ${doc.title}\n${url}`;
        deliveryKind = "file";
      } else if (doc.documentNumber) {
        dmText = `${doc.title}: ${doc.documentNumber}`;
        deliveryKind = "number";
      } else {
        await client.models.homePendingAuthChallenge.delete({ id: challengeId });
        return JSON.stringify({ status: "ERROR", reason: "Document has no file or number to release" });
      }

      // Deliver via DM
      await client.models.homeOutboundMessage.create({
        channel: "WHATSAPP",
        target: "PERSON",
        personId: ch.personId,
        text: dmText,
        status: "PENDING",
        kind: "document_release",
      });

      await client.models.homeDocumentAccessLog.create({
        documentId: ch.documentId,
        personId: ch.personId,
        channel: channelForLog,
        action: "LINK_ISSUED",
        result: "SUCCESS",
      });

      // Look up requester + owner for transparency DM
      const { data: reqPerson } = await client.models.homePerson.get({ id: ch.personId });
      if (
        DOCUMENT_ACCESS_NOTIFICATIONS_ENABLED &&
        doc.scope === "PERSONAL" &&
        doc.ownerPersonId &&
        doc.ownerPersonId !== ch.personId
      ) {
        const docTypeLabel = doc.type
          ? (doc.type as string).toLowerCase().replace(/_/g, " ")
          : "document";
        await client.models.homeOutboundMessage.create({
          channel: "WHATSAPP",
          target: "PERSON",
          personId: doc.ownerPersonId,
          text: `Heads up: ${reqPerson?.name ?? "someone"} just accessed your ${docTypeLabel}: '${doc.title}'. If this wasn't expected, let Gennaro know.`,
          status: "PENDING",
          kind: "document_access_notification",
        });
      }

      // Update lastUsedAt on the auth row
      const allAuths = await client.models.homePersonAuth.list();
      const authRow = (allAuths.data ?? []).find((a: any) => a.personId === ch.personId);
      if (authRow) {
        await client.models.homePersonAuth.update({
          id: authRow.id,
          lastUsedAt: new Date().toISOString(),
        });
      }

      await client.models.homePendingAuthChallenge.delete({ id: challengeId });

      return JSON.stringify({
        status: "DELIVERED",
        deliveredVia: "DM",
        deliveryKind,
        documentTitle: doc.title,
      });
    }

    // ── Device control (v2) ────────────────────────────────────────────
    case "control_device": {
      const entityId = input.entityId as string;
      const service = input.service as string;
      const serviceData = (input.serviceData as Record<string, any>) ?? {};
      const senderName = input.senderName as string;
      const domain = entityDomain(entityId);

      // 1. Look up homeDevice by entityId from DDB cache
      const { data: deviceRows } = await client.models.homeDevice.list({
        filter: { entityId: { eq: entityId } },
        limit: 1,
      });
      const device = (deviceRows ?? [])[0];
      if (!device) {
        return JSON.stringify({
          status: "ERROR",
          reason: `Device ${entityId} not found in cache. Run a device sync first.`,
        });
      }

      // 2. Determine sensitivity tier — treat null/undefined as READ_ONLY
      const sensitivity: Sensitivity =
        (device.sensitivity as Sensitivity | null) ?? "READ_ONLY";

      // 3. Determine action direction
      const safeServices = new Set([
        "lock",
        "close_cover",
        "turn_off",
      ]);
      const action: Action = safeServices.has(service)
        ? "control_safe"
        : "control_unsafe";

      // 4. Resolve sender -> homePerson
      const people = await getPeople();
      const requester = people.find(
        (p) => p.name.toLowerCase() === senderName.toLowerCase()
      );
      if (!requester) {
        return JSON.stringify({
          status: "ERROR",
          reason: `No household member named "${senderName}"`,
        });
      }

      // 5. Check wifi presence via HA device_tracker entity
      let senderHomeWifi = false;
      try {
        const { data: personRow } = await client.models.homePerson.get({
          id: requester.id,
        });
        const trackerEntity = personRow?.homeDeviceTrackerEntity;
        if (trackerEntity) {
          const hassBaseUrl = process.env.HASS_BASE_URL;
          const hassToken = process.env.HASS_TOKEN;
          if (hassBaseUrl && hassToken) {
            const ha = new HassClient(hassBaseUrl, hassToken);
            const trackerState = await ha.getState(trackerEntity);
            senderHomeWifi = trackerState.state === "home";
          }
        }
      } catch (err) {
        // Fail closed — treat as not on wifi
        console.warn("[control_device] wifi check failed:", err);
      }

      // 6. Build policy context and evaluate
      const policyCtx: PolicyContext = {
        origin: "AGENT",
        senderHomeWifi,
        elevatedSession: false,
      };
      const decision = canPerform(sensitivity, action, policyCtx);

      // 7. Handle policy decision
      if (!decision.allowed) {
        await client.models.homeDeviceAction.create({
          personId: requester.id,
          entityId,
          action: service,
          params: serviceData,
          origin: "AGENT",
          senderHomeWifi,
          elevatedSession: false,
          result: "DENIED",
          error: decision.reason,
        });
        return JSON.stringify({
          status: "DENIED",
          reason: decision.reason,
          requires: decision.requires ?? null,
        });
      }

      // 7a. Duo Push required (HIGH sensitivity)
      if (decision.requires === "duo_push") {
        const { data: auths } = await client.models.homePersonAuth.list({
          filter: { personId: { eq: requester.id } },
          limit: 10,
        });
        const authRow = (auths ?? [])[0];
        if (!authRow?.duoUsername) {
          await client.models.homeDeviceAction.create({
            personId: requester.id,
            entityId,
            action: service,
            params: serviceData,
            origin: "AGENT",
            senderHomeWifi,
            elevatedSession: false,
            result: "DENIED",
            error: "not_enrolled",
          });
          return JSON.stringify({
            status: "DENIED",
            reason: "not_enrolled",
            note: `${requester.name} has not linked a Duo account. Have them visit /security.`,
          });
        }

        // Preauth
        let preauthRes;
        try {
          preauthRes = await duoPreauth(authRow.duoUsername);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await client.models.homeDeviceAction.create({
            personId: requester.id,
            entityId,
            action: service,
            params: serviceData,
            origin: "AGENT",
            senderHomeWifi,
            elevatedSession: false,
            result: "FAILED",
            error: `preauth: ${msg}`.slice(0, 500),
          });
          return JSON.stringify({ status: "ERROR", reason: `preauth_failed: ${msg}` });
        }

        if (preauthRes.result === "deny" || preauthRes.result === "enroll") {
          await client.models.homeDeviceAction.create({
            personId: requester.id,
            entityId,
            action: service,
            params: serviceData,
            origin: "AGENT",
            senderHomeWifi,
            elevatedSession: false,
            result: "DENIED",
            error: preauthRes.result === "deny" ? "locked_out" : "not_enrolled",
          });
          return JSON.stringify({
            status: "DENIED",
            reason: preauthRes.result === "deny" ? "locked_out" : "not_enrolled",
          });
        }

        // Create challenge row — encode action details in conversationKey
        // so check_device_auth can reconstruct the pending action after a
        // Lambda cold start (module-level Maps don't survive).
        const conversationKey =
          `device:${entityId}:${service}:${JSON.stringify(serviceData)}`;
        const challengeExpiresAt = new Date(
          Date.now() + 5 * 60 * 1000
        ).toISOString();
        const { data: challenge } =
          await client.models.homePendingAuthChallenge.create({
            conversationKey,
            personId: requester.id,
            documentId: entityId, // repurposed — stores entityId for device challenges
            attemptsRemaining: 1,
            expiresAt: challengeExpiresAt,
          });

        // Fire async push
        if (preauthRes.result === "auth") {
          try {
            const friendlyName = device.friendlyName ?? entityId;
            const res = await duoPushAuth({
              username: authRow.duoUsername,
              pushinfo: {
                Device: friendlyName,
                Action: service,
                "Requested by": requester.name,
              },
              type: "Device control",
              displayUsername: authRow.duoUsername,
              async: "1",
            });
            // Append txid to conversationKey for retrieval
            if (challenge?.id && res.txid) {
              await client.models.homePendingAuthChallenge.update({
                id: challenge.id,
                conversationKey: `${conversationKey}:txid:${res.txid}`,
              });
            }
            console.log(
              "[control_device] push sent, txid:",
              res.txid,
              "challengeId:",
              challenge?.id
            );
            return JSON.stringify({
              status: "PUSH_SENT",
              challengeId: challenge?.id,
              txid: res.txid,
              message:
                "Duo push sent. Call check_device_auth with the challengeId and txid to poll for approval. Tell the user to approve the push on their phone.",
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (challenge?.id) {
              await client.models.homePendingAuthChallenge.delete({
                id: challenge.id,
              });
            }
            await client.models.homeDeviceAction.create({
              personId: requester.id,
              entityId,
              action: service,
              params: serviceData,
              origin: "AGENT",
              senderHomeWifi,
              elevatedSession: false,
              result: "FAILED",
              error: `push: ${msg}`.slice(0, 500),
            });
            return JSON.stringify({
              status: "ERROR",
              reason: `push_failed: ${msg}`,
            });
          }
        }

        // Pre-approved (rare "allow" from preauth) — fall through to execute
      }

      // 7b. Reply confirm required (MEDIUM on wifi, LOW remote)
      if (decision.requires === "reply_confirm") {
        return JSON.stringify({
          status: "CONFIRM_REQUIRED",
          message: `Please confirm: ${service} on ${device.friendlyName ?? entityId}. Reply "yes" to proceed.`,
          entityId,
          service,
          serviceData,
        });
      }

      // 8. Execute immediately (LOW on wifi, or pre-approved HIGH)
      try {
        const hassBaseUrl = process.env.HASS_BASE_URL;
        const hassToken = process.env.HASS_TOKEN;
        if (!hassBaseUrl || !hassToken) {
          throw new Error("HASS_BASE_URL or HASS_TOKEN not configured");
        }
        const ha = new HassClient(hassBaseUrl, hassToken);
        await ha.callService(domain, service, {
          entity_id: entityId,
          ...serviceData,
        });

        // Write SUCCESS audit log
        await client.models.homeDeviceAction.create({
          personId: requester.id,
          entityId,
          action: service,
          params: serviceData,
          origin: "AGENT",
          senderHomeWifi,
          elevatedSession: false,
          result: "SUCCESS",
        });

        // Refresh cached state
        let newState: unknown = null;
        try {
          const refreshed = await ha.getState(entityId);
          newState = refreshed;
          await client.models.homeDevice.update({
            id: device.id,
            lastState: JSON.stringify(refreshed),
            lastSyncedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn("[control_device] state refresh failed:", err);
        }

        return JSON.stringify({
          status: "EXECUTED",
          entityId,
          service,
          newState,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await client.models.homeDeviceAction.create({
          personId: requester.id,
          entityId,
          action: service,
          params: serviceData,
          origin: "AGENT",
          senderHomeWifi,
          elevatedSession: false,
          result: "FAILED",
          error: msg.slice(0, 500),
        });
        return JSON.stringify({ status: "ERROR", reason: msg });
      }
    }

    case "check_device_auth": {
      const { challengeId, txid } = input as {
        challengeId: string;
        txid: string;
      };
      if (!challengeId || !txid) {
        return JSON.stringify({
          status: "ERROR",
          reason: "challengeId and txid are required",
        });
      }

      // 1. Poll Duo
      let pollResult: Awaited<ReturnType<typeof duoAuthStatus>>;
      try {
        pollResult = await duoAuthStatus(txid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          status: "ERROR",
          reason: `duo_poll_failed: ${msg}`,
        });
      }

      if (pollResult.result === "waiting") {
        return JSON.stringify({
          status: "WAITING",
          message:
            "User hasn't responded to the Duo push yet. Call check_device_auth again in a few seconds.",
        });
      }

      // 2. Fetch challenge row
      const { data: ch } = await client.models.homePendingAuthChallenge.get({
        id: challengeId,
      });
      if (!ch) {
        return JSON.stringify({
          status: "ERROR",
          reason: "Challenge not found or expired",
        });
      }

      // Parse action details from conversationKey:
      // "device:<entityId>:<service>:<jsonServiceData>:txid:<txid>"
      const convKey = ch.conversationKey;
      const devicePrefix = "device:";
      const txidSuffix = `:txid:${txid}`;
      const actionPart = convKey.startsWith(devicePrefix)
        ? convKey.slice(devicePrefix.length).replace(txidSuffix, "")
        : "";
      // actionPart = "<entityId>:<service>:<jsonServiceData>"
      const firstColon = actionPart.indexOf(":");
      const secondColon = actionPart.indexOf(":", firstColon + 1);
      const pendingEntityId = actionPart.slice(0, firstColon);
      const pendingService = actionPart.slice(firstColon + 1, secondColon);
      let pendingServiceData: Record<string, any> = {};
      try {
        pendingServiceData = JSON.parse(actionPart.slice(secondColon + 1));
      } catch {}
      const pendingDomain = entityDomain(pendingEntityId);

      if (pollResult.result === "deny") {
        await client.models.homePendingAuthChallenge.delete({
          id: challengeId,
        });
        await client.models.homeDeviceAction.create({
          personId: ch.personId,
          entityId: pendingEntityId,
          action: pendingService,
          params: pendingServiceData,
          origin: "AGENT",
          result: "DENIED",
          error: "user_denied_or_timeout",
        });
        return JSON.stringify({ status: "DENIED", reason: "user_denied" });
      }

      // 3. Approved — execute the HA service call
      try {
        const hassBaseUrl = process.env.HASS_BASE_URL;
        const hassToken = process.env.HASS_TOKEN;
        if (!hassBaseUrl || !hassToken) {
          throw new Error("HASS_BASE_URL or HASS_TOKEN not configured");
        }
        const ha = new HassClient(hassBaseUrl, hassToken);
        await ha.callService(pendingDomain, pendingService, {
          entity_id: pendingEntityId,
          ...pendingServiceData,
        });

        // Audit log
        await client.models.homeDeviceAction.create({
          personId: ch.personId,
          entityId: pendingEntityId,
          action: pendingService,
          params: pendingServiceData,
          origin: "AGENT",
          result: "SUCCESS",
        });

        // Refresh cached state
        let newState: unknown = null;
        try {
          const refreshed = await ha.getState(pendingEntityId);
          newState = refreshed;
          const { data: devRows } = await client.models.homeDevice.list({
            filter: { entityId: { eq: pendingEntityId } },
            limit: 1,
          });
          const dev = (devRows ?? [])[0];
          if (dev) {
            await client.models.homeDevice.update({
              id: dev.id,
              lastState: JSON.stringify(refreshed),
              lastSyncedAt: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.warn("[check_device_auth] state refresh failed:", err);
        }

        await client.models.homePendingAuthChallenge.delete({
          id: challengeId,
        });

        return JSON.stringify({
          status: "EXECUTED",
          entityId: pendingEntityId,
          service: pendingService,
          newState,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await client.models.homeDeviceAction.create({
          personId: ch.personId,
          entityId: pendingEntityId,
          action: pendingService,
          params: pendingServiceData,
          origin: "AGENT",
          result: "FAILED",
          error: msg.slice(0, 500),
        });
        await client.models.homePendingAuthChallenge.delete({
          id: challengeId,
        });
        return JSON.stringify({ status: "ERROR", reason: msg });
      }
    }

    // ── Checklist tools ─────────────────────────────────────────────────

    case "manage_checklist": {
      const { action } = input;

      if (action === "create") {
        if (!input.entityType || !input.entityId || !input.name) {
          return JSON.stringify({ error: "entityType, entityId, and name are required for create" });
        }
        const { data, errors } = await client.models.homeChecklist.create({
          entityType: input.entityType,
          entityId: input.entityId,
          name: input.name,
          sortOrder: 0,
        });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, checklistId: data?.id, name: input.name });
      }

      if (action === "rename") {
        if (!input.checklistId || !input.name) {
          return JSON.stringify({ error: "checklistId and name are required for rename" });
        }
        const { data, errors } = await client.models.homeChecklist.update({
          id: input.checklistId,
          name: input.name,
        });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, checklistId: data?.id, name: input.name });
      }

      if (action === "delete") {
        if (!input.checklistId) {
          return JSON.stringify({ error: "checklistId is required for delete" });
        }
        // Cascade-delete items first
        const { data: items } = await client.models.homeChecklistItem.list({
          filter: { checklistId: { eq: input.checklistId } }, limit: 500,
        });
        let itemsDeleted = 0;
        for (const item of items ?? []) {
          await client.models.homeChecklistItem.delete({ id: item.id });
          itemsDeleted++;
        }
        const { errors } = await client.models.homeChecklist.delete({ id: input.checklistId });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, checklistId: input.checklistId, itemsDeleted });
      }

      // Duplicate a checklist (all items copied with isDone=false) to a
      // target entity. If no target specified, duplicates to the same entity.
      if (action === "duplicate") {
        if (!input.checklistId) {
          return JSON.stringify({ error: "checklistId is required for duplicate" });
        }
        const { data: source } = await client.models.homeChecklist.get({ id: input.checklistId });
        if (!source) return JSON.stringify({ error: "Source checklist not found" });
        const eType = input.entityType ?? source.entityType;
        const eId = input.entityId ?? source.entityId;
        const { data: newCl } = await client.models.homeChecklist.create({
          entityType: eType, entityId: eId, name: source.name, sortOrder: 0,
        });
        if (!newCl) return JSON.stringify({ error: "Failed to create duplicate" });
        const { data: srcItems } = await client.models.homeChecklistItem.list({
          filter: { checklistId: { eq: source.id } }, limit: 500,
        });
        let itemsCopied = 0;
        for (const item of (srcItems ?? []).sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
          await client.models.homeChecklistItem.create({
            checklistId: newCl.id, text: item.text, section: item.section, isDone: false, sortOrder: item.sortOrder ?? 0,
          });
          itemsCopied++;
        }
        return JSON.stringify({ success: true, checklistId: newCl.id, name: source.name, itemsCopied });
      }

      // Save a checklist as a reusable template
      if (action === "save_as_template") {
        if (!input.checklistId) {
          return JSON.stringify({ error: "checklistId is required for save_as_template" });
        }
        const { data: source } = await client.models.homeChecklist.get({ id: input.checklistId });
        if (!source) return JSON.stringify({ error: "Source checklist not found" });
        const { data: tmpl } = await client.models.homeChecklist.create({
          entityType: "TEMPLATE" as any, entityId: "templates", name: source.name, sortOrder: 0,
        });
        if (!tmpl) return JSON.stringify({ error: "Failed to create template" });
        const { data: srcItems } = await client.models.homeChecklistItem.list({
          filter: { checklistId: { eq: source.id } }, limit: 500,
        });
        let itemsCopied = 0;
        for (const item of (srcItems ?? []).sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
          await client.models.homeChecklistItem.create({
            checklistId: tmpl.id, text: item.text, section: item.section, isDone: false, sortOrder: item.sortOrder ?? 0,
          });
          itemsCopied++;
        }
        return JSON.stringify({ success: true, templateId: tmpl.id, name: source.name, itemsCopied });
      }

      // Create a checklist from an existing template
      if (action === "from_template") {
        if (!input.templateId || !input.entityType || !input.entityId) {
          return JSON.stringify({ error: "templateId, entityType, and entityId are required for from_template" });
        }
        const { data: tmpl } = await client.models.homeChecklist.get({ id: input.templateId });
        if (!tmpl) return JSON.stringify({ error: "Template not found" });
        const { data: newCl } = await client.models.homeChecklist.create({
          entityType: input.entityType, entityId: input.entityId, name: tmpl.name, sortOrder: 0,
        });
        if (!newCl) return JSON.stringify({ error: "Failed to create checklist from template" });
        const { data: tmplItems } = await client.models.homeChecklistItem.list({
          filter: { checklistId: { eq: tmpl.id } }, limit: 500,
        });
        let itemsCopied = 0;
        for (const item of (tmplItems ?? []).sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
          await client.models.homeChecklistItem.create({
            checklistId: newCl.id, text: item.text, section: item.section, isDone: false, sortOrder: item.sortOrder ?? 0,
          });
          itemsCopied++;
        }
        return JSON.stringify({ success: true, checklistId: newCl.id, name: tmpl.name, itemsCopied });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }

    case "manage_checklist_items": {
      const { action, checklistId } = input;
      const batchItems = (input.items as any[]) ?? [];

      if (action === "add") {
        // Batch add: if items array provided, create all at once
        if (batchItems.length > 0) {
          const results: { text: string; section?: string }[] = [];
          for (const item of batchItems) {
            const text = (item.text ?? "").trim();
            if (!text) continue;
            const payload: Record<string, any> = {
              checklistId, text, isDone: false, sortOrder: results.length,
            };
            if (item.section) payload.section = item.section;
            await (client.models.homeChecklistItem as any).create(payload);
            results.push({ text, section: item.section });
          }
          return JSON.stringify({ success: true, added: results.length, items: results });
        }
        // Single add (backward compatible)
        if (!input.text) {
          return JSON.stringify({ error: "text or items array is required for add" });
        }
        const payload: Record<string, any> = {
          checklistId, text: input.text, isDone: false, sortOrder: 0,
        };
        if (input.section) payload.section = input.section;
        const { data, errors } = await (client.models.homeChecklistItem as any).create(payload);
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, itemId: data?.id, text: input.text, section: input.section ?? null });
      }

      if (action === "toggle") {
        // Batch toggle
        if (batchItems.length > 0) {
          const results: { itemId: string; isDone: boolean }[] = [];
          for (const item of batchItems) {
            if (!item.itemId) continue;
            const { data: existing } = await client.models.homeChecklistItem.get({ id: item.itemId });
            if (!existing) continue;
            const nowDone = !existing.isDone;
            await client.models.homeChecklistItem.update({
              id: item.itemId, isDone: nowDone, doneAt: nowDone ? new Date().toISOString() : null,
            });
            results.push({ itemId: item.itemId, isDone: nowDone });
          }
          return JSON.stringify({ success: true, toggled: results.length, items: results });
        }
        // Single toggle
        if (!input.itemId) return JSON.stringify({ error: "itemId is required for toggle" });
        const { data: item } = await client.models.homeChecklistItem.get({ id: input.itemId });
        if (!item) return JSON.stringify({ error: "Item not found" });
        const nowDone = !item.isDone;
        const { data, errors } = await client.models.homeChecklistItem.update({
          id: input.itemId, isDone: nowDone, doneAt: nowDone ? new Date().toISOString() : null,
        });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, itemId: data?.id, isDone: nowDone, text: item.text });
      }

      if (action === "rename") {
        if (!input.itemId || !input.text) {
          return JSON.stringify({ error: "itemId and text are required for rename" });
        }
        const { data, errors } = await client.models.homeChecklistItem.update({ id: input.itemId, text: input.text });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, itemId: data?.id, text: input.text });
      }

      if (action === "remove") {
        // Batch remove
        if (batchItems.length > 0) {
          let removed = 0;
          for (const item of batchItems) {
            if (!item.itemId) continue;
            await client.models.homeChecklistItem.delete({ id: item.itemId });
            removed++;
          }
          return JSON.stringify({ success: true, removed });
        }
        // Single remove
        if (!input.itemId) return JSON.stringify({ error: "itemId is required for remove" });
        const { errors } = await client.models.homeChecklistItem.delete({ id: input.itemId });
        if (errors) return JSON.stringify({ error: errors[0].message });
        return JSON.stringify({ success: true, itemId: input.itemId });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }

    case "list_checklists": {
      let checklists: Schema["homeChecklist"]["type"][];

      if (input.entityId) {
        const { data } = await client.models.homeChecklist.list({
          filter: { entityId: { eq: input.entityId } }, limit: 500,
        });
        checklists = data ?? [];
      } else if (input.entityType) {
        const { data } = await client.models.homeChecklist.list({
          filter: { entityType: { eq: input.entityType } }, limit: 500,
        });
        checklists = data ?? [];
      } else {
        const { data } = await client.models.homeChecklist.list();
        checklists = data ?? [];
      }

      // Fetch items for each checklist
      const results = await Promise.all(
        checklists.map(async (cl) => {
          const { data: items } = await client.models.homeChecklistItem.list({
            filter: { checklistId: { eq: cl.id } }, limit: 500,
          });
          const sortedItems = (items ?? []).sort(
            (a: Schema["homeChecklistItem"]["type"], b: Schema["homeChecklistItem"]["type"]) =>
              (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          );
          return {
            id: cl.id,
            entityType: cl.entityType,
            entityId: cl.entityId,
            name: cl.name,
            items: sortedItems.map((i: Schema["homeChecklistItem"]["type"]) => ({
              id: i.id,
              text: i.text,
              isDone: i.isDone,
              doneAt: i.doneAt,
            })),
          };
        })
      );

      return JSON.stringify({ checklists: results });
    }

    case "attach_file": {
      const { data, errors } = await client.models.homeAttachment.create({
        parentType: input.parentType,
        parentId: input.parentId,
        s3Key: input.s3Key,
        filename: input.filename,
        contentType: input.contentType ?? null,
        caption: input.caption ?? null,
        uploadedBy: "agent",
      });
      if (errors?.length) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        attachmentId: data?.id,
        caption: input.caption ?? input.filename,
        parentType: input.parentType,
        parentId: input.parentId,
      });
    }

    case "list_attachments": {
      const { data: attachments } = await client.models.homeAttachment.list({
        filter: {
          parentId: { eq: input.parentId },
          ...(input.parentType ? { parentType: { eq: input.parentType } } : {}),
        },
        limit: 100,
      });
      const sorted = (attachments ?? []).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      return JSON.stringify({
        attachments: sorted.map((a) => ({
          id: a.id,
          filename: a.filename,
          caption: a.caption,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          uploadedBy: a.uploadedBy,
          createdAt: a.createdAt,
        })),
        count: sorted.length,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

interface AgentArgs {
  message: string;
  history?: any[];
  sender?: string;
  imageS3Keys?: string[] | null;
  chatContext?: string | ChatContext | null;
}

interface AgentResponse {
  message: string;
  actionsTaken: { tool: string; result: any }[];
  attachments?: Attachment[];
}

// Payload shape for direct Lambda invoke (from the WhatsApp bot). Unlike
// the AppSync path, the bot persists the inbound message + its attachments
// in DynamoDB before invoking the Lambda with InvocationType="Event". The
// Lambda then:
//   1. Loads the inbound row, enforces idempotency (PENDING → PROCESSING)
//   2. Fetches its attachments via homeAttachment rows (parentId match)
//   3. Runs the normal agent loop
//   4. Writes the response + any tool-generated attachments to
//      homeOutboundMessage / homeAttachment (parentType=OUTBOUND_MESSAGE)
//   5. Marks the inbound as RESPONDED
// The bot's existing outbound poller (5s interval) picks up the response
// and delivers it via WhatsApp. No AppSync 30s timeout in the critical
// path — Duo flows and long agent chains have the full 120s Lambda budget.
interface AsyncInvokePayload {
  inboundMessageId: string;
  history?: any[];
  sender?: string;
  chatContext?: string | ChatContext | null;
  replyTarget: {
    target: "GROUP" | "PERSON";
    groupJid?: string | null;
    personId?: string | null;
  };
}

function isAsyncInvoke(event: any): event is AsyncInvokePayload {
  return event && !event.arguments && typeof event.inboundMessageId === "string";
}

export const handler = async (event: any, context?: any): Promise<AgentResponse | void> => {
  const isAsync = isAsyncInvoke(event);

  // Normalize args from either invocation mode. In async mode, pull the
  // user message + attachments from DynamoDB; everything else (history,
  // sender, chatContext) still rides on the invocation payload since those
  // are per-call state the bot already knows.
  let args: AgentArgs;
  let replyTarget: AsyncInvokePayload["replyTarget"] | null = null;
  let inboundMessageId: string | null = null;
  const preloadedMedia: MediaPayload[] = [];

  if (isAsync) {
    inboundMessageId = event.inboundMessageId;
    replyTarget = event.replyTarget;

    if (!replyTarget) {
      console.error(`[agent] async invoke missing replyTarget for inbound ${inboundMessageId}`);
      return;
    }

    const client = await getDataClient();

    // Idempotency: only process PENDING. Lambda's async-invoke retry
    // policy (2 retries by default) would otherwise trigger the agent 3x
    // on transient failures.
    const { data: inbound, errors: getErrors } = await client.models.homeInboundMessage.get({
      id: inboundMessageId!,
    });
    if (getErrors?.length) {
      console.error(`[agent] failed to load inbound ${inboundMessageId}:`, getErrors);
      return;
    }
    if (!inbound) {
      console.warn(`[agent] inbound ${inboundMessageId} not found, skipping`);
      return;
    }
    if (inbound.status !== "PENDING") {
      console.log(
        `[agent] inbound ${inboundMessageId} is ${inbound.status}, skipping (idempotency)`
      );
      return;
    }

    // Lock: mark as PROCESSING. Not a true atomic conditional write (the
    // Amplify data client doesn't expose DynamoDB ConditionExpression),
    // but the status check above + the quick update below is good enough
    // to deflect Lambda's automatic retries — a second invocation will
    // see PROCESSING and bail.
    await client.models.homeInboundMessage.update({
      id: inboundMessageId!,
      status: "PROCESSING",
      processingStartedAt: new Date().toISOString(),
      agentLambdaRequestId: context?.awsRequestId ?? null,
    });

    // Load attachments (images, PDFs, future media types) attached to the
    // inbound message.
    const { data: atts } = await client.models.homeAttachment.list({
      filter: { parentId: { eq: inboundMessageId! } },
    });
    for (const att of atts ?? []) {
      if (!att.s3Key) continue;
      try {
        const m = await fetchAttachmentAsMedia(att.s3Key, att.contentType ?? "");
        if (m) preloadedMedia.push(m);
      } catch (err) {
        console.warn(`[agent] Failed to load attachment ${att.s3Key}:`, err);
      }
    }

    args = {
      message: inbound.text ?? "",
      history: event.history ?? [],
      sender: event.sender ?? inbound.senderName ?? "unknown",
      imageS3Keys: [], // Not used in async mode — attachments came via homeAttachment
      chatContext: event.chatContext ?? null,
    };
  } else {
    args = event.arguments;
  }

  const {
    message: userMessage,
    history: conversationHistory = [],
    sender = "unknown",
    imageS3Keys = [],
    chatContext: rawChatContext,
  } = args;

  const now = new Date();
  const people = await getPeople();
  const peopleNames = people.map((p) => p.name).join(", ");

  // Format date and time consistently in the household's local timezone.
  // Mixing `now.toISOString()` (UTC) with a localized weekday previously
  // produced inconsistent strings like "Thursday April 10" — UTC date but
  // local day name — which made the model compute weekday-relative dates
  // ("Saturday") off by one day.
  const TZ = "America/Chicago";
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const systemPrompt = `You are Janet, the household assistant for Gennaro and Cristine. You help manage tasks, bills, calendar events, shopping lists, photos, home devices, weather briefings, and reminders.

Household members: ${peopleNames}
Today is ${dateFmt.format(now)}. Current local time: ${timeFmt.format(now)}.
Timezone: ${TZ} (Central)
Message sender: ${sender}

When assigning tasks/bills/events to people, pass their names in the assignedPeople array (e.g. ["Gennaro"], ["Cristine"], or ["both"] for the whole household). Empty/omitted = household.

When the user asks to see photos, call send_photos DIRECTLY with whatever album or trip name they mentioned (it does fuzzy matching internally — do NOT call list_trips or list_albums first). Pass the name in the "query" param. It's capped at 5 photos per call — if more match, mention the count and share the deepLink the tool returns so the user can view the rest.

## Device control

You can control Home Assistant devices using control_device. The household's
risk policy gates access by device sensitivity:

- READ_ONLY: no control (sensors, cameras)
- LOW: execute immediately (lights, plugs) — may ask for "reply yes" confirmation if the sender is not on home wifi
- MEDIUM: requires sender to be on home wifi (thermostat, covers)
- HIGH: requires Duo Push approval (locks, garage, alarm) — same async flow as document downloads: call control_device -> tell user to approve push -> call check_device_auth

When a user says "lock the back door" or "set the thermostat to 72", use
control_device. Check get_home_devices first if you need the entity_id.

Common services by domain:
- lock: lock, unlock
- cover: open_cover, close_cover
- climate: set_temperature (pass {temperature: N} in serviceData)
- light/switch/fan: turn_on, turn_off, toggle

When control_device returns CONFIRM_REQUIRED (reply confirm), ask the user
"Are you sure?" and if they confirm, call control_device again — the second
call will execute because the user's confirmation counts as the reply.

For weather / TAF / METAR / "what's the forecast" / "what's the wind" questions, call get_weather_briefing. By default it uses KAUS and auto-selects plain vs aviation mode. Pass mode="aviation" if the user is clearly asking about flying conditions, or pass a different ICAO if they name an airport. The tool returns structured data including the raw METAR and TAF — for a household-level question render a plain line; for a pilot question include the raw strings and the VFR/MVFR/IFR verdict.

## Reminders

Reminders are persistent recurring or one-off notifications delivered via WhatsApp. Two flavors:
- **Single-item reminder**: "remind me to pick up the kids at 3pm" → call schedule_reminder with firesAt. "Remind us every morning at 8am to take out the trash" → schedule_reminder with an RRULE.
- **Compound reminder (multiple items with different schedules)**: "remind us to take supplements — B12 at 8pm, Omega-3 at 9am and 9pm" → call schedule_compound_reminder with an items array. The sweep bundles items that come due in the same window into ONE message. Use this for medication regimens, supplement stacks, anything where related items share context.

For medications/supplements specifically, always use schedule_compound_reminder (even if one item) and set kind="medication". Set useLlm=true (default) so the message wording varies across firings.

Default target is the household group. Only pass personName if the user explicitly wants it DM'd to a specific person ("remind Cristine privately that...").

RRULE examples:
- Every day at 8pm: "RRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=0"
- Every 6 hours: "RRULE:FREQ=HOURLY;INTERVAL=6"
- Twice daily (9am and 9pm): create TWO items, one with BYHOUR=9 one with BYHOUR=21
- Mondays and Thursdays at 7am: "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=7;BYMINUTE=0"

For a time-limited prescription ("every 6 hours for 5 days"), set endDate on the item.

Use list_reminders to answer "what reminders do I have". Use cancel_reminder / pause_reminder / resume_reminder for management. Prefer passing a reminderId when you've just looked one up; otherwise use the query field to fuzzy-match by name.

## Document vault

The household has a document vault for passports, licenses, insurance, etc.
Use list_documents or get_document_expirations freely to answer metadata
questions ("when does my passport expire?", "what's expiring this month?").
These return redacted metadata only.

When a user asks for the actual file or document number ("send me my
passport", "what's my Global Entry number?"), use the two-step flow:

1. Call request_document_download — it fires an ASYNC Duo push and
   returns {status: "PUSH_SENT", challengeId, txid}. Tell the user to
   approve the Duo push on their phone.
2. Call check_document_auth with the challengeId and txid to poll.
   - If WAITING: call check_document_auth again (the tool loop iterates).
   - If DELIVERED: confirm to the user ("Sent to your DM").
   - If DENIED: tell the user the push was denied or timed out.

You MUST NOT paste the downloaded file URL or document number in your text
response to the user. The tool handles delivery via DM automatically and
returns only a sanitized {status, deliveredVia} result. Your reply should
just confirm the delivery ("Sent to your DM — tap the link to open your
passport. It expires in 30 minutes.") or explain the error.

If the current conversation is a group chat, acknowledge the request in
group with something like "Approve the Duo push on your phone" after
calling request_document_download.

Never include documentNumber from list_documents output in your responses —
the tool returns "<REDACTED>" and you should not try to work around this.

Be concise and friendly. When creating items, confirm what you did. If the user's request is ambiguous, ask for clarification. Use the tools available to take actions — don't just describe what you would do.`;

  // Build messages for Anthropic API format
  // History comes from AppSync as JSON — normalize to valid MessageParam[].
  //
  // Image rehydration: if a *user* history item carries attachments shaped
  // like { type: "image", s3Key }, refetch the bytes and replay them as
  // image content blocks so multi-turn image memory works. Assistant
  // attachments come from send_photos (CloudFront URLs Claude never
  // actually saw) and are intentionally NOT rehydrated.
  //
  // NOTE (phase 1): the agent chat client currently strips attachments
  // when serializing history into the mutation payload, so this loop is
  // a no-op until phase 2 wires the client to pass them through. When it
  // does, rehydration will activate without further handler changes.
  const rawHistory: any[] = Array.isArray(conversationHistory)
    ? conversationHistory
    : typeof conversationHistory === "string"
      ? (() => {
          try {
            return JSON.parse(conversationHistory);
          } catch {
            return [];
          }
        })()
      : [];

  const validHistory: Anthropic.MessageParam[] = [];
  for (const m of rawHistory) {
    if (!m || !m.role || m.content == null) continue;
    const role = m.role as "user" | "assistant";

    // Try image rehydration on user turns only.
    if (role === "user" && Array.isArray(m.attachments) && m.attachments.length > 0) {
      const imageKeys: string[] = m.attachments
        .filter((a: any) => a && a.type === "image" && typeof a.s3Key === "string")
        .map((a: any) => a.s3Key as string);

      if (imageKeys.length > 0) {
        const fetched: MediaPayload[] = [];
        for (const key of imageKeys) {
          try {
            fetched.push(await fetchImageAsBase64(key));
          } catch (err) {
            console.warn(`[agent] Failed to rehydrate history image ${key}:`, err);
          }
        }
        const text = typeof m.content === "string" ? m.content : String(m.content);
        validHistory.push({ role, content: buildUserContent(fetched, text) });
        continue;
      }
    }

    validHistory.push({
      role,
      content: typeof m.content === "string" ? m.content : String(m.content),
    });
  }

  // Collect all attachments for the current user turn. Async mode has
  // already populated preloadedMedia from the homeAttachment table; the
  // AppSync path still loads images by key from imageS3Keys.
  const currentMedia: MediaPayload[] = [...preloadedMedia];
  if (!isAsync) {
    for (const key of imageS3Keys ?? []) {
      if (!key) continue;
      try {
        currentMedia.push(await fetchImageAsBase64(key));
      } catch (err) {
        console.warn(`[agent] Failed to fetch user-uploaded image ${key}:`, err);
      }
    }
  }

  const messages: Anthropic.MessageParam[] = [
    ...validHistory,
    { role: "user" as const, content: buildUserContent(currentMedia, userMessage) },
  ];

  const actionsTaken: { tool: string; result: any }[] = [];
  // Parse the chatContext arg. It arrives as AWSJSON (a string) from the
  // WA bot, or as an object from the web UI (which doesn't pass it yet).
  let parsedChatContext: ChatContext = { channel: "WEB", chatJid: null };
  if (rawChatContext) {
    try {
      const cc =
        typeof rawChatContext === "string"
          ? JSON.parse(rawChatContext)
          : rawChatContext;
      if (cc && cc.channel) {
        parsedChatContext = {
          channel: cc.channel as AgentChannel,
          chatJid: cc.chatJid ?? null,
        };
      }
    } catch {
      // Malformed — keep default
    }
  }
  const toolCtx: ToolContext = {
    attachments: [],
    chatContext: parsedChatContext,
    sender,
  };

  try {
    // Agentic loop
    let response = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    });

    while (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          // Log every tool call + its result + duration. Essential for
          // diagnosing "the agent said it did X but the UI shows nothing"
          // — without this we're guessing from Claude's narrative which
          // sometimes hallucinates success on tool errors.
          const t0 = Date.now();
          console.log(
            `[agent-tool] call: ${block.name} input=${JSON.stringify(block.input).slice(0, 500)}`
          );
          const result = await executeTool(block.name, block.input as Record<string, any>, toolCtx);
          const ms = Date.now() - t0;
          console.log(
            `[agent-tool] done: ${block.name} (${ms}ms) result=${result.slice(0, 500)}`
          );
          actionsTaken.push({ tool: block.name, result: JSON.parse(result) });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: MODEL_ID,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        tools,
      });
    }

    // Extract final text response
    const assistantText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (isAsync && replyTarget && inboundMessageId) {
      const client = await getDataClient();

      // Write the main text response to the outbound queue. The bot's
      // 5s poller picks it up and delivers via WhatsApp.
      const { data: outbound, errors: outboundErrors } =
        await client.models.homeOutboundMessage.create({
          channel: "WHATSAPP",
          target: replyTarget.target,
          groupJid: replyTarget.groupJid ?? null,
          personId: replyTarget.personId ?? null,
          text: assistantText || "(no response)",
          status: "PENDING",
          kind: "agent_reply",
        });
      if (outboundErrors?.length) {
        console.error(`[agent] failed to create outbound for ${inboundMessageId}:`, outboundErrors);
      }

      // Write each tool-generated attachment (currently all from
      // send_photos) as a homeAttachment row pointed at the new outbound
      // message. Using s3Key to store the full CloudFront URL when the
      // URL isn't a direct S3 path — the bot detects this at delivery
      // time and passes the URL straight to Baileys. A future session
      // should add a proper `sourceUrl` field to homeAttachment to avoid
      // this overload.
      if (outbound?.id) {
        for (const att of toolCtx.attachments) {
          if (!att.url) continue;
          try {
            await client.models.homeAttachment.create({
              parentType: "OUTBOUND_MESSAGE",
              parentId: outbound.id,
              s3Key: att.url, // URL or S3 key; bot checks with looksLikeUrl
              filename: att.caption?.split(" · ")[2] ?? `${att.type}.jpg`,
              contentType: att.type === "image" ? "image/jpeg" : att.type,
              caption: att.caption ?? null,
              uploadedBy: "agent",
            });
          } catch (err) {
            console.warn(`[agent] Failed to write outbound attachment for ${outbound.id}:`, err);
          }
        }
      }

      // Close out the inbound message row.
      await client.models.homeInboundMessage.update({
        id: inboundMessageId,
        status: "RESPONDED",
        outboundMessageId: outbound?.id ?? null,
        respondedAt: new Date().toISOString(),
      });

      return;
    }

    return {
      message: assistantText,
      actionsTaken,
      attachments: toolCtx.attachments,
    };
  } catch (err) {
    if (isAsync && replyTarget && inboundMessageId) {
      // Async mode: surface the error to the user via a FAILED outbound
      // message so the chat doesn't just go silent. Also mark the inbound
      // as FAILED so Lambda's async retry logic sees a terminal state
      // and won't re-invoke the agent. (Idempotency check skips anything
      // that isn't PENDING.)
      console.error(`[agent] async processing failed for inbound ${inboundMessageId}:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        const client = await getDataClient();
        const { data: errOutbound } = await client.models.homeOutboundMessage.create({
          channel: "WHATSAPP",
          target: replyTarget.target,
          groupJid: replyTarget.groupJid ?? null,
          personId: replyTarget.personId ?? null,
          text: "Sorry, I ran into an error processing your message. Please try again.",
          status: "PENDING",
          kind: "agent_error",
        });
        await client.models.homeInboundMessage.update({
          id: inboundMessageId,
          status: "FAILED",
          outboundMessageId: errOutbound?.id ?? null,
          error: errMsg.slice(0, 500),
        });
      } catch (persistErr) {
        console.error(`[agent] failed to persist error state for ${inboundMessageId}:`, persistErr);
      }
      return;
    }
    throw err;
  }
};
