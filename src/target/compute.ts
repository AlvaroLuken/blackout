import { createHash } from "node:crypto";

// The target service's own job logic. Driven entirely by its config file,
// so a bad config value breaks real job processing while /health stays green.
export type ServiceConfig = {
  service: string;
  version: string;
  fingerprint: { algorithm: string; encoding: string };
  normalize: { unicode: string; lowercase: boolean; collapse_whitespace: boolean };
  delivery: { sink: string; batch_size: number };
  log_level: string;
};

export const HEALTHY_CONFIG: ServiceConfig = {
  service: "docprint",
  version: "2.3.1",
  fingerprint: { algorithm: "sha256", encoding: "hex" },
  normalize: { unicode: "NFC", lowercase: true, collapse_whitespace: true },
  delivery: { sink: "ledger", batch_size: 25 },
  log_level: "info",
};

export function normalizeText(text: string, cfg: ServiceConfig): string {
  let t = text.normalize(cfg.normalize.unicode as "NFC" | "NFD" | "NFKC" | "NFKD");
  if (cfg.normalize.lowercase) t = t.toLowerCase();
  if (cfg.normalize.collapse_whitespace) t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function computePayload(jobId: string, text: string, cfg: ServiceConfig) {
  const norm = normalizeText(text, cfg);
  const fingerprint = createHash(cfg.fingerprint.algorithm)
    .update(norm, "utf8")
    .digest(cfg.fingerprint.encoding as "hex" | "base64");
  const word_count = norm === "" ? 0 : norm.split(" ").length;
  return { job_id: jobId, fingerprint, word_count };
}
