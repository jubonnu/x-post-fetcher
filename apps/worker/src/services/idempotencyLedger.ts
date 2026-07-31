import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.ts";
import { idempotencyRecords } from "../db/schema.ts";
import { isUniqueConstraintViolation } from "../repositories/userRepository.ts";

/**
 * `idempotency_records`の保持期間（日数）。7〜30日の初期候補のうち14日を採用する
 * （Mobile-G2B-4: 計画書7章）。削除バッチは本フェーズでは実装しない
 * （Cron Trigger実装までは不要、という要件に従う。定数化のみ行い将来の削除バッチに備える）。
 */
export const IDEMPOTENCY_LEDGER_RETENTION_DAYS = 14;

/**
 * G2B-Hardening: 書き込み系エンドポイントすべてに台帳を適用する（対象を限定していた
 * Mobile-G2B-4時点から拡張）。scopeはリソース種別ごとに分け、`requestHash`へ
 * operationType・resourceKeyを含めることで、同一clientRequestIdの
 * 「別payloadへの誤用」「別操作種別（put/patch/delete）への誤用」
 * 「別対象（resourceKey）への誤用」のすべてを検知できるようにする。
 */
export type IdempotencyScope =
  | "user_lottery"
  | "user_favorite"
  | "followed_product"
  | "notification_preferences"
  | "checklist_step"
  | "sync_bootstrap";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 冪等性判定対象のリクエスト内容から決定的なハッシュを計算する。
 * 呼び出し側は常に同じキー順序でpayloadオブジェクトを組み立てること（`JSON.stringify`は
 * オブジェクトの挿入順を保持するため、キー順序が安定していれば結果も安定する）。
 */
export async function computeRequestHash(payload: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(payload));
}

export type LedgerLookupResult =
  | { status: "not_found" }
  | { status: "match"; responseJson: string }
  | { status: "conflict" };

/** 台帳を検索し、再送か・誤用（IDEMPOTENCY_CONFLICT対象）かを判定する。 */
export async function lookupIdempotencyRecord(
  db: DbOrTx,
  params: { userId: number; scope: IdempotencyScope; clientRequestId: string; requestHash: string }
): Promise<LedgerLookupResult> {
  const rows = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.userId, params.userId),
        eq(idempotencyRecords.scope, params.scope),
        eq(idempotencyRecords.clientRequestId, params.clientRequestId)
      )
    );
  const existing = rows[0];
  if (!existing) return { status: "not_found" };
  if (existing.requestHash !== params.requestHash) return { status: "conflict" };
  return { status: "match", responseJson: existing.responseJson };
}

/** 処理結果を台帳へ記録する。 */
export async function recordIdempotencyResult(
  db: DbOrTx,
  params: { userId: number; scope: IdempotencyScope; clientRequestId: string; requestHash: string; response: unknown }
): Promise<void> {
  await db.insert(idempotencyRecords).values({
    userId: params.userId,
    scope: params.scope,
    clientRequestId: params.clientRequestId,
    requestHash: params.requestHash,
    responseJson: JSON.stringify(params.response),
  });
}

/** 同一clientRequestIdを別payload・別操作種別・別対象へ誤用した（＝台帳のハッシュ不一致）。 */
export class IdempotencyConflictError extends Error {
  constructor(message = "clientRequestIdが別内容の操作で既に使用されています") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * 冪等性台帳の確認・業務ロジックの実行・台帳への記録を**単一のDBトランザクション**で行う
 * （Mobile-G2B-Hardening）。台帳だけ、または対象データだけが残る中間状態を作らないための
 * 中心的なヘルパー。`operation`が例外を投げた場合（VersionConflictError等の業務エラー）は
 * トランザクション全体がロールバックされ、台帳には何も記録されない
 * （そのclientRequestIdは「まだ確定した結果を持たない」ままとなり、状態が変わった後の
 * 再送では改めて評価される。楽観的ロック競合は「その時点の状態」に依存する性質のもので、
 * 遅延再送防止とは異なる関心事のため、意図的に台帳へキャッシュしない）。
 *
 * 同時実行で同一`(userId, scope, clientRequestId)`が競合した場合、片方はUNIQUE制約違反で
 * 敗れる。500にはせず、勝者が記録した結果を再照会して返す
 * （G2A/G2B-1で確立した「同時作成の競合は再照会して収束させる」パターンと同型）。
 */
export async function runIdempotent<T>(
  db: Db,
  params: { userId: number; scope: IdempotencyScope; clientRequestId: string; requestPayload: unknown },
  operation: (tx: DbOrTx) => Promise<T>
): Promise<T> {
  const requestHash = await computeRequestHash(params.requestPayload);

  try {
    return await db.transaction(async (tx) => {
      const lookup = await lookupIdempotencyRecord(tx, {
        userId: params.userId,
        scope: params.scope,
        clientRequestId: params.clientRequestId,
        requestHash,
      });
      if (lookup.status === "match") return JSON.parse(lookup.responseJson) as T;
      if (lookup.status === "conflict") throw new IdempotencyConflictError();

      const result = await operation(tx);
      await recordIdempotencyResult(tx, {
        userId: params.userId,
        scope: params.scope,
        clientRequestId: params.clientRequestId,
        requestHash,
        response: result,
      });
      return result;
    });
  } catch (e) {
    if (isUniqueConstraintViolation(e)) {
      const winner = await lookupIdempotencyRecord(db, {
        userId: params.userId,
        scope: params.scope,
        clientRequestId: params.clientRequestId,
        requestHash,
      });
      if (winner.status === "match") return JSON.parse(winner.responseJson) as T;
      if (winner.status === "conflict") throw new IdempotencyConflictError();
    }
    throw e;
  }
}
