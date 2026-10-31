// What an op gets to work with. Each surface builds one: the ops Lambda for
// web/mobile, the agent Lambda for Janet and the Muse API.

export type OpVia = "web" | "mobile" | "whatsapp" | "api" | "cli";

/** Saves images for ops. Keys come back under `prefix` (e.g. home/wardrobe/). */
export interface OpImageStorage {
  /** Downloads an https image and stores it. */
  storeFromUrl(url: string, prefix: string): Promise<string>;
  /** Copies an image an API client uploaded via POST /uploads (home/inventory/…). */
  copyUpload(uploadKey: string, prefix: string): Promise<string>;
}

export interface OpContext {
  // Amplify data client. Typed loosely for the reason given in lib/list-all.ts.
  client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  storage: OpImageStorage;
  actor: {
    via: OpVia;
    personName?: string | null; // default person for ops that take one
  };
}
