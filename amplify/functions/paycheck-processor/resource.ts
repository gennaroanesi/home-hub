import { defineFunction } from "@aws-amplify/backend";

// Paystubs → homePaycheckInbox for review, never homePaycheck directly.
//   - S3 trigger: SES stores mail for paychecks@import.cristinegennaro.com in
//     the inbound bucket under paychecks/ (backend.ts wires the notification;
//     scripts/setup-finance-inbound-email.sh the SES rule).
//   - parsePaycheckPdf mutation: a PDF uploaded from /finance/paychecks →
//     extraction draft for the review form.
// No HTML rendering: payroll emails only say "your statement is ready", so a
// forward must carry the PDF.
export const paycheckProcessor = defineFunction({
  name: "paycheck-processor",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
