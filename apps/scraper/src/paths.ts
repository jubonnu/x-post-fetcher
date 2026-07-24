import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// apps/scraper/src/ を基点にリポジトリルートを解決（auth.json / output は従来どおりルート）
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const AUTH_STATE = resolve(REPO_ROOT, "auth.json");
export const OUTPUT_DIR = resolve(REPO_ROOT, "output");
