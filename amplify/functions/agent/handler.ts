import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "$amplify/env/home-agent";
import type { Schema } from "../../data/resource";
import {
  DEFAULT_ICAO,
  fetchAirportWeather,
  getMorningWeatherBriefing,
} from "../../../lib/aviation-weather.js";
import { DOCUMENT_ACCESS_NOTIFICATIONS_ENABLED } from "../../../lib/feature-flags.js";
import { preauth as duoPreauth, pushAuth as duoPushAuth, authStatus as duoAuthStatus } from "./duo.js";

const anthropic = new Anthropic();
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});

// ── Image attachment helper ──────────────────────────────────────────────────
// User-uploaded images live under home/agent-uploads/ in the photos bucket
// (PHOTOS_BUCKET env var, set in backend.ts). The agent Lambda has
// s3:GetObject scoped to that prefix only.

type ImagePayload = { mediaType: string; data: string };

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

async function fetchImageAsBase64(s3Key: string): Promise<ImagePayload> {
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
    mediaType: res.ContentType ?? inferImageMediaType(s3Key),
    data: buf.toString("base64"),
  };
}

// Build a Claude user message content array from optional images + text.
// Returns the plain text string when there are no images, so the existing
// no-image path stays byte-identical.
function buildUserContent(
  images: ImagePayload[],
  text: string
): string | Anthropic.ContentBlockParam[] {
  if (images.length === 0) return text;
  const blocks: Anthropic.ContentBlockParam[] = images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: img.data,
    },
  }));
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
    description: "Schedule a notification reminder via EventBridge. Use for task/bill/event reminders.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names to notify. Use ['both'] for household.",
        },
        scheduleAt: { type: "string", description: "ISO 8601 datetime for one-time reminder" },
        recurrence: { type: "string", description: "RRULE or cron expression for recurring" },
        type: { type: "string", enum: ["task", "bill", "event"] },
      },
      required: ["message"],
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
      "List Home Assistant devices (thermostats, locks, cameras, sensors, etc.) with their last known state. Read-only in v1 — cannot control devices yet. Filter by domain (climate, lock, cover, camera, sensor, switch, etc.) or area (room name). Without filters, returns all pinned devices. State is cached from the last sync (daily + on-demand).",
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
      const scheduleName = `home-reminder-${generateId()}`;
      const scheduleExpression = input.recurrence
        ? `cron(${input.recurrence})`
        : `at(${input.scheduleAt})`;
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);

      await scheduler.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: scheduleExpression,
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: SCHEDULER_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            assignedPersonIds,
            message: input.message,
            type: input.type ?? "task",
          }),
        },
        ActionAfterCompletion: input.recurrence ? "NONE" : "DELETE",
      }));
      return JSON.stringify({ success: true, scheduleName });
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
          "Read-only in v1. To control devices, ask the user to do it in the web app for now.",
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
      const channelForLog: "WA" | "WEB" =
        ctx.chatContext.channel === "WEB" ? "WEB" : "WA";

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
        ctx.chatContext.chatJid != null
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

      // 7. Build payload — either a presigned URL (file-backed) or the
      //    raw documentNumber (metadata-only entries like Global Entry).
      let dmText = "";
      let deliveryKind: "file" | "number" = "number";
      if (doc.s3Key) {
        const bucket = process.env.PHOTOS_BUCKET;
        if (!bucket) {
          return JSON.stringify({
            status: "ERROR",
            reason: "PHOTOS_BUCKET env var not set",
          });
        }
        const filename = doc.originalFilename ?? `${doc.title ?? "document"}`;
        // Quote-escape the filename for the Content-Disposition header.
        const safeFilename = filename.replace(/"/g, "");
        const getCmd = new GetObjectCommand({
          Bucket: bucket,
          Key: doc.s3Key,
          ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
        });
        const url = await getSignedUrl(s3, getCmd, { expiresIn: 30 * 60 });
        dmText = `Here's your document: ${doc.title}\n${url}\n(Link expires in 30 minutes.)`;
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
        const bucket = process.env.PHOTOS_BUCKET;
        if (!bucket) {
          return JSON.stringify({ status: "ERROR", reason: "PHOTOS_BUCKET env var not set" });
        }
        const filename = doc.originalFilename ?? `${doc.title ?? "document"}`;
        const safeFilename = filename.replace(/"/g, "");
        const getCmd = new GetObjectCommand({
          Bucket: bucket,
          Key: doc.s3Key,
          ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
        });
        const url = await getSignedUrl(s3, getCmd, { expiresIn: 30 * 60 });
        dmText = `Here's your document: ${doc.title}\n${url}\n(Link expires in 30 minutes.)`;
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

export const handler: AppSyncResolverHandler<AgentArgs, AgentResponse> = async (event) => {
  const {
    message: userMessage,
    history: conversationHistory = [],
    sender = "unknown",
    imageS3Keys = [],
    chatContext: rawChatContext,
  } = event.arguments;

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

Home devices (thermostat, locks, cameras, etc.) can be read via get_home_devices. Device control is NOT available yet — if the user asks to change something (e.g. "set the thermostat to 72"), tell them to do it in the web app.

For weather / TAF / METAR / "what's the forecast" / "what's the wind" questions, call get_weather_briefing. By default it uses KAUS and auto-selects plain vs aviation mode. Pass mode="aviation" if the user is clearly asking about flying conditions, or pass a different ICAO if they name an airport. The tool returns structured data including the raw METAR and TAF — for a household-level question render a plain line; for a pilot question include the raw strings and the VFR/MVFR/IFR verdict.

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
        const fetched: ImagePayload[] = [];
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

  // Fetch any newly-attached images for the current user turn.
  const currentImages: ImagePayload[] = [];
  for (const key of imageS3Keys ?? []) {
    if (!key) continue;
    try {
      currentImages.push(await fetchImageAsBase64(key));
    } catch (err) {
      console.warn(`[agent] Failed to fetch user-uploaded image ${key}:`, err);
    }
  }

  const messages: Anthropic.MessageParam[] = [
    ...validHistory,
    { role: "user" as const, content: buildUserContent(currentImages, userMessage) },
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
  };

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
        const result = await executeTool(block.name, block.input as Record<string, any>, toolCtx);
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

  return {
    message: assistantText,
    actionsTaken,
    attachments: toolCtx.attachments,
  };
};
