// What an op gets to work with. Each surface builds one: the ops Lambda for
// web/mobile, the agent Lambda for Janet and the Muse API.

export type OpVia = "web" | "mobile" | "whatsapp" | "api" | "cli";

/** Saves images for ops. Keys come back under `prefix` (e.g. home/wardrobe/). */
export interface OpImageStorage {
  /** Downloads an https image and stores it. */
  storeFromUrl(url: string, prefix: string): Promise<string>;
  /** Copies an image an API client uploaded via POST /uploads (home/inventory/…). */
  copyUpload(uploadKey: string, prefix: string): Promise<string>;
  /** Stores image bytes already in hand (a small base64 image from the API). */
  storeBytes?(img: { data: Buffer; contentType: string }, prefix: string): Promise<string>;
}

export interface OpContext {
  // Amplify data client. Typed loosely for the reason given in lib/list-all.ts.
  client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  storage: OpImageStorage;
  actor: {
    via: OpVia;
    personName?: string | null; // default person for ops that take one
    /**
     * The caller's Cognito username when the surface knows it for sure
     * (web / mobile through the ops Lambda: AppSync's verified identity).
     * Owner-only data (lib/inventory-details.ts private types) goes only to
     * its owner: this login, else the person named by personName.
     */
    username?: string | null;
    /** A WhatsApp group chat: owner-only data is never shown here. */
    groupChat?: boolean;
  };
  /**
   * A signed /api/d link to a file under home/ (lib/file-link.ts), where the
   * surface can mint one (the agent Lambda, for Janet and the API). Ops
   * leave links out when it's missing; never hand out bare S3 URLs.
   */
  fileLink?: (s3Key: string) => Promise<string>;
  /** S3 keys of photos sent with the message that triggered the op (Janet). */
  messageImageKeys?: string[];
}
