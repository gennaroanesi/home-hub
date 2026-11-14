// Document vault helpers shared by web, mobile and Janet.

/**
 * Opening a document's file or number needs a second factor (Duo push;
 * Face ID on the phone) unless it was marked not sensitive, e.g. floor
 * plans or a warranty. Unset counts as sensitive.
 */
export function documentIsSensitive(doc: { isSensitive?: boolean | null }): boolean {
  return doc.isSensitive !== false;
}

/** Short link to a vault file: /api/d/<file> redirects to home/documents/<file>. */
export function documentFileUrl(s3Key: string, baseUrl = "https://home.cristinegennaro.com"): string {
  return `${baseUrl}/api/d/${s3Key.replace(/^home\/documents\//, "")}`;
}
