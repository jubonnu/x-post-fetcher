/**
 * lottery_update_candidates.candidate_key の生成（Phase 11・純関数）。
 *
 * 1つの投稿が複数抽選に分割される場合、分割順序（candidateIndex）は再解析のたびに
 * 変わりうる（抽出ロジックの改善でセクションの検出順が変わる等）ため、それ単体では
 * 「同じ投稿の再解析で、これは前回と同じ論理候補である」という判定に使えない。
 * 代わりに正規化済み商品名・店舗名という内容ベースの値からキーを生成し、順序が変わっても
 * 同じ候補として扱えるようにする（商品名・店舗名がどちらも空の場合のみ candidateIndex へ
 * フォールバックする）。
 */
export interface CandidateKeyInput {
  normalizedProductName: string | null | undefined;
  normalizedStoreName: string | null | undefined;
  candidateIndex: number;
}

export function buildLotteryUpdateCandidateKey(input: CandidateKeyInput): string {
  const product = input.normalizedProductName?.trim() || "";
  const store = input.normalizedStoreName?.trim() || "";
  if (product || store) {
    return `p:${product}|s:${store}`;
  }
  return `idx:${input.candidateIndex}`;
}

/**
 * 同一投稿内に「商品名・店舗名が完全に同じだが別の抽選」が複数存在する場合（同名店舗の
 * 別枠・まとめ投稿内の表記重複等、実データ上は稀だが起こりうる）、`buildLotteryUpdateCandidateKey`
 * が同じキーを返してしまい `(source_post_id, candidate_key)` の一意制約に衝突する。
 *
 * これを避けるため、呼び出し側（`syncLotteriesFromAnalysis`）は同一投稿内で同じベースキーが
 * 何回目の出現かを数え、2回目以降にこの関数でキーを一意化してから使う。1回目（最も一般的な
 * ケース）は元のキーのまま返すため、重複が無い投稿では従来通り安定したキーになる
 * （再解析での安定性はベースキー＝商品名・店舗名に由来する。重複がある投稿に限っては、
 * 抽出順序が再解析で入れ替わると出現回数の対応がずれる可能性があるが、これは
 * 「商品名・店舗名だけでは区別できない」ケース自体が本質的に曖昧なため許容する）。
 */
export function disambiguateCandidateKey(baseKey: string, occurrenceIndex: number): string {
  return occurrenceIndex === 0 ? baseKey : `${baseKey}#${occurrenceIndex + 1}`;
}
