import type { Db } from "../db/client.ts";
import { getLatestParserVersion } from "../repositories/analysisRepository.ts";
import {
  applyLotteryUpdateCandidate,
  getLotteryUpdateCandidateDiff,
  ignoreLotteryUpdateCandidate,
  type LotteryUpdateCandidateDiff,
} from "../repositories/lotteryUpdateCandidateRepository.ts";
import { MANUAL_INGEST_PARSER_VERSION } from "./claudeIngestTransform.ts";

export type AutoResolveAction = "apply" | "ignore" | "skip";

export interface AutoResolveDecision {
  action: AutoResolveAction;
  /** action="apply"の場合、実際に反映するフィールド名。 */
  fields: string[];
  reason: string;
}

/**
 * 更新候補1件について、既存データとの差分（addable/overwritable/conflictingFields）と
 * 候補の元データがClaude in Chrome由来かどうかから、自動処理してよいかを判定する（純関数）。
 *
 * ルール（優先順）:
 * 1. targetLotteryが無い・conflictingFieldsが1件でもある → skip（人間の確認に残す。
 *    conflictingは「本当に同じ抽選か怪しい」ケースを含むため安全側に倒す）
 * 2. addable/overwritableどちらも0件（完全一致） → ignore（変更不要、処理済みにする）
 * 3. overwritableFieldsが0件（addableのみ） → apply（既存の空欄を埋めるだけなので常に安全）
 * 4. overwritableFieldsがある（既存の値を上書きする）→ 候補がClaude in Chrome由来
 *    （parserVersion === MANUAL_INGEST_PARSER_VERSION）の場合のみapply。
 *    regexパイプライン由来の候補は精度への信頼度が異なるため自動化しない。
 */
export function decideAutoResolution(diff: LotteryUpdateCandidateDiff, isClaudeSourced: boolean): AutoResolveDecision {
  if (!diff.targetLottery) {
    return { action: "skip", fields: [], reason: "target_lottery_not_found" };
  }
  if (diff.conflictingFields.length > 0) {
    return { action: "skip", fields: [], reason: "has_conflicting_fields" };
  }
  if (diff.addableFields.length === 0 && diff.overwritableFields.length === 0) {
    return { action: "ignore", fields: [], reason: "no_changes" };
  }
  if (diff.overwritableFields.length === 0) {
    return { action: "apply", fields: diff.addableFields.map((f) => f.fieldName), reason: "addable_only" };
  }
  if (isClaudeSourced) {
    return {
      action: "apply",
      fields: [...diff.addableFields, ...diff.overwritableFields].map((f) => f.fieldName),
      reason: "claude_sourced_overwrite",
    };
  }
  return { action: "skip", fields: [], reason: "overwrite_requires_claude_source" };
}

export type AutoResolveOneResult =
  | { ok: true; candidateId: number; decision: AutoResolveDecision; applied: boolean }
  | { ok: false; candidateId: number; error: "candidate_not_found" | "candidate_already_resolved" | "apply_failed" };

/**
 * 更新候補1件について判定し、`dryRun=false`なら実際に反映する（既存のapply/ignore処理を
 * そのまま呼ぶ。新しいDB書き込みロジックは追加しない）。1件ずつ呼ぶ設計にしているのは、
 * まとめて処理するとCloudflare Workersの1リクエストあたりサブリクエスト数上限に達するため
 * （Claude投入機能で実際に発生した障害と同じ理由。呼び出し側で候補IDごとにループする）。
 */
export async function autoResolveLotteryUpdateCandidate(db: Db, candidateId: number, dryRun: boolean): Promise<AutoResolveOneResult> {
  const diff = await getLotteryUpdateCandidateDiff(db, candidateId);
  if (!diff) return { ok: false, candidateId, error: "candidate_not_found" };
  if (diff.candidate.status !== "pending") return { ok: false, candidateId, error: "candidate_already_resolved" };

  const parserVersion = await getLatestParserVersion(db, diff.candidate.sourcePostId);
  const isClaudeSourced = parserVersion === MANUAL_INGEST_PARSER_VERSION;
  const decision = decideAutoResolution(diff, isClaudeSourced);

  if (dryRun || decision.action === "skip") {
    return { ok: true, candidateId, decision, applied: false };
  }

  if (decision.action === "ignore") {
    const result = await ignoreLotteryUpdateCandidate(db, candidateId, "auto-resolve");
    if (result === "candidate_not_found" || result === "candidate_already_resolved") {
      return { ok: false, candidateId, error: result };
    }
    return { ok: true, candidateId, decision, applied: true };
  }

  // decision.action === "apply"
  const result = await applyLotteryUpdateCandidate(db, candidateId, decision.fields, "auto-resolve");
  if (typeof result === "string") {
    if (result === "candidate_not_found" || result === "candidate_already_resolved") {
      return { ok: false, candidateId, error: result };
    }
    // "target_lottery_not_found" | "no_fields_selected" は decideAutoResolution の前提から
    // 起こらないはずだが、型上は起こりうるため安全側でskip相当として報告する。
    return { ok: false, candidateId, error: "apply_failed" };
  }
  return { ok: true, candidateId, decision, applied: true };
}
