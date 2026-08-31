import type { ApiErrorBody } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const TOKEN_STORAGE_KEY = "cardhub-admin-token";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** 画像アップロード等、JSON以外の生バイナリを送る場合に使う。指定時は`body`をそのままfetchへ渡す。 */
  rawBody?: BodyInit;
  rawContentType?: string;
  auth?: boolean;
}

/**
 * `/admin/*` API共通のfetchラッパー。認証エラー（401）を投げた場合、呼び出し側
 * （`AuthContext`のエラーハンドリング）がトークンを破棄してログイン画面へ戻す想定。
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError("CONFIG_ERROR", "VITE_API_BASE_URLが設定されていません", 500);
  }

  const headers: Record<string, string> = {};
  if (options.auth !== false) {
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (options.rawContentType) headers["Content-Type"] = options.rawContentType;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { method: options.method ?? "GET", headers, body });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("Content-Type") ?? "";
  const json = contentType.includes("application/json") ? await res.json() : null;

  if (!res.ok) {
    const errorBody = json as ApiErrorBody | null;
    throw new ApiError(errorBody?.error.code ?? "UNKNOWN", errorBody?.error.message ?? `リクエストに失敗しました（${res.status}）`, res.status);
  }

  return json as T;
}
