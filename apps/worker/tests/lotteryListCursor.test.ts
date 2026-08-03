import { describe, expect, it } from "vitest";
import {
  decodeLotteryListCursor,
  encodeLotteryListCursor,
  InvalidCursorError,
  type LotteryListCursor,
} from "../src/services/lotteryListCursor.ts";

const VALID: LotteryListCursor = { priority: 0, sortKey: 1753776000, id: 42, asOf: "2026-08-03T00:00:00.000Z" };

describe("lotteryListCursor", () => {
  it("encode → decode で同じ値に戻る（往復一致）", () => {
    const encoded = encodeLotteryListCursor(VALID);
    const decoded = decodeLotteryListCursor(encoded);
    expect(decoded).toEqual(VALID);
  });

  it("負のsortKey（終了済みグループ）も往復できる", () => {
    const cursor: LotteryListCursor = { priority: 2, sortKey: -1753776000, id: 1, asOf: VALID.asOf };
    expect(decodeLotteryListCursor(encodeLotteryListCursor(cursor))).toEqual(cursor);
  });

  it("base64urlとして不正な文字を含む場合は例外", () => {
    expect(() => decodeLotteryListCursor("not valid base64url!!!")).toThrow(InvalidCursorError);
  });

  it("base64としては解読できてもJSONでない場合は例外", () => {
    const notJson = btoa("this is not json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => decodeLotteryListCursor(notJson)).toThrow(InvalidCursorError);
  });

  it("JSONだが必須フィールドが欠けている場合は例外", () => {
    const encoded = btoa(JSON.stringify({ priority: 0, id: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeLotteryListCursor(encoded)).toThrow(InvalidCursorError);
  });

  it("priorityが範囲外（0〜3以外）の場合は例外", () => {
    const encoded = encodeLotteryListCursor({ ...VALID, priority: 4 as LotteryListCursor["priority"] });
    expect(() => decodeLotteryListCursor(encoded)).toThrow(InvalidCursorError);
  });

  it("priorityが整数でない場合は例外", () => {
    const bogus = btoa(JSON.stringify({ ...VALID, priority: 1.5 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeLotteryListCursor(bogus)).toThrow(InvalidCursorError);
  });

  it("idが0以下の場合は例外", () => {
    const bogus = btoa(JSON.stringify({ ...VALID, id: 0 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeLotteryListCursor(bogus)).toThrow(InvalidCursorError);
  });

  it("asOfが日時としてパースできない場合は例外", () => {
    const bogus = btoa(JSON.stringify({ ...VALID, asOf: "not-a-date" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeLotteryListCursor(bogus)).toThrow(InvalidCursorError);
  });

  it("改ざんして別の妥当なpriority/id等に差し替えても、形式が正しければデコードできる（値の真偽検証はDB側の役割）", () => {
    const tampered: LotteryListCursor = { priority: 3, sortKey: 0, id: 99999, asOf: VALID.asOf };
    const encoded = encodeLotteryListCursor(tampered);
    expect(decodeLotteryListCursor(encoded)).toEqual(tampered);
  });
});
