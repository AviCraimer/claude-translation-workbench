import { createHash } from "node:crypto";

/** Fingerprint of a target HTML string (Node side only). */
export const fingerprint = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
