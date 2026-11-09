import { defineFunction } from "@aws-amplify/backend";

// Household invoices → homeInvoice (+ homeInvoiceLink when exactly one
// transaction matches).
//   - S3 trigger: SES stores mail for invoices@import.cristinegennaro.com in
//     the inbound bucket under invoices/.
//   - ingestInvoicePdf mutation: a PDF uploaded from /finance/invoices.
// An email without a PDF is rendered to one with headless Chromium, from the
// public @sparticuz/chromium layer (same layer and version as
// gennaroanesi.com's invoiceProcessor); declaring it here also keeps the
// module out of the esbuild bundle. 2 GB for Chromium.
export const invoiceProcessor = defineFunction({
  name: "invoice-processor",
  timeoutSeconds: 120,
  memoryMB: 2048,
  resourceGroupName: "data",
  layers: {
    // x86_64, us-east-1 — Chromium v149 (github.com/shelfio/chrome-aws-lambda-layer)
    "@sparticuz/chromium": "arn:aws:lambda:us-east-1:764866452798:layer:chrome-aws-lambda:115",
  },
});
