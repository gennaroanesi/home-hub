// Recurrence presets shared between the form modal and the list rows.
// Matches /pages/tasks.tsx so a task created on web shows the same
// label on mobile and vice versa. We deliberately don't ship the
// full `rrule` package — it's only needed for custom rules, which
// the mobile UI doesn't expose. Custom rrules created on web fall
// through to "Custom recurrence" until the user edits on web again.

export const RECURRENCE_PRESETS: { label: string; value: string }[] = [
  { label: "Daily", value: "RRULE:FREQ=DAILY" },
  { label: "Weekdays", value: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Weekly", value: "RRULE:FREQ=WEEKLY" },
  { label: "Biweekly", value: "RRULE:FREQ=WEEKLY;INTERVAL=2" },
  { label: "Monthly", value: "RRULE:FREQ=MONTHLY" },
  { label: "Monthly 1st", value: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1" },
  { label: "Monthly 15th", value: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15" },
  { label: "Quarterly", value: "RRULE:FREQ=MONTHLY;INTERVAL=3" },
  { label: "Yearly", value: "RRULE:FREQ=YEARLY" },
];

/** Best-effort label for a stored RRULE string. Falls back to "Custom". */
export function formatRecurrence(rrule: string | null | undefined): string | null {
  if (!rrule) return null;
  const preset = RECURRENCE_PRESETS.find((p) => p.value === rrule);
  return preset?.label ?? "Custom";
}
