/**
 * SQLiteの`SQLITE_BUSY`（同一DBへの同時書き込みによるロック競合）判定（Mobile-G2A残修正）。
 *
 * 背景: ローカルのlibSQLファイルクライアントで、同一Apple subによる同時初回ログインのように
 * 複数リクエストが同時にDBへ書き込もうとすると`SQLITE_BUSY`が発生し得ることを確認した。
 * `@libsql/client`はデフォルトでbusy_timeoutによる自動待機を行わず即座にエラーを返すため、
 * 接続時に`PRAGMA busy_timeout`を設定している（`db/client.node.ts`）。これによりSQLite自身が
 * ロック解放を待つため、通常はここまでエラーが到達しない。busy_timeoutの猶予を超える
 * 極端な同時アクセス時の最終防御として、ルートハンドラ側でこの判定関数を使い
 * 生の例外を返さず安全なエラーレスポンスに変換する（`routes/auth.ts`参照）。
 */
export function isSqliteBusyError(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return code === "SQLITE_BUSY";
}
