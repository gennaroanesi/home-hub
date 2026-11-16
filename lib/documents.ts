// Document vault helpers shared by web, mobile and Janet.

/**
 * Opening a document's file or number needs a second factor (Duo push;
 * Face ID on the phone) unless it was marked not sensitive, e.g. floor
 * plans or a warranty. Unset counts as sensitive.
 */
export function documentIsSensitive(doc: { isSensitive?: boolean | null }): boolean {
  return doc.isSensitive !== false;
}

// Links to a vault file are signed and expire (lib/file-link.ts
// signedFileLink); there is no bare /api/d/<file> URL any more, since
// the bucket only answers unsigned requests from the home network.
