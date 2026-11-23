import { defineFunction } from "@aws-amplify/backend";

// Writes homeCalendarEvent changes back to two-way (CalDAV) calendars, on
// the table's DynamoDB stream (wired in backend.ts). Logic in
// lib/calendar-sync.ts.
export const calendarPush = defineFunction({
  name: "calendar-push",
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: "data",
});
