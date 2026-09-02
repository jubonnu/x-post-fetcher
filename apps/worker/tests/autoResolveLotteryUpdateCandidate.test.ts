import { describe, expect, it } from "vitest";
import { decideAutoResolution } from "../src/services/autoResolveLotteryUpdateCandidate.ts";
import type { LotteryUpdateCandidateDiff } from "../src/repositories/lotteryUpdateCandidateRepository.ts";
import type { LotteryRow } from "../src/db/schema.ts";

function baseDiff(overrides: Partial<LotteryUpdateCandidateDiff> = {}): LotteryUpdateCandidateDiff {
  return {
    candidate: {} as LotteryUpdateCandidateDiff["candidate"],
    targetLottery: {} as LotteryRow,
    extractedData: {} as LotteryUpdateCandidateDiff["extractedData"],
    addableFields: [],
    overwritableFields: [],
    conflictingFields: [],
    matchingFields: [],
    ...overrides,
  };
}

const field = (fieldName: string) => ({ fieldName, oldValue: null, newValue: "x", changeType: "updated" as const });

describe("decideAutoResolution", () => {
  it("targetLotteryが無ければskip", () => {
    const decision = decideAutoResolution(baseDiff({ targetLottery: null }), false);
    expect(decision).toEqual({ action: "skip", fields: [], reason: "target_lottery_not_found" });
  });

  it("conflictingFieldsが1件でもあればskip（Claude由来でも）", () => {
    const decision = decideAutoResolution(baseDiff({ conflictingFields: [field("applicationEndDate")] }), true);
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("has_conflicting_fields");
  });

  it("差分が無ければignore", () => {
    const decision = decideAutoResolution(baseDiff(), false);
    expect(decision).toEqual({ action: "ignore", fields: [], reason: "no_changes" });
  });

  it("addableFieldsのみ（overwritable無し）は、Claude由来でなくてもapply", () => {
    const decision = decideAutoResolution(baseDiff({ addableFields: [field("region")] }), false);
    expect(decision.action).toBe("apply");
    expect(decision.fields).toEqual(["region"]);
    expect(decision.reason).toBe("addable_only");
  });

  it("overwritableFieldsがあり、regexパイプライン由来（Claude由来でない）ならskip", () => {
    const decision = decideAutoResolution(baseDiff({ overwritableFields: [field("storeNameRaw")] }), false);
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("overwrite_requires_claude_source");
  });

  it("overwritableFieldsがあり、Claude in Chrome由来ならapply（addable+overwritable両方）", () => {
    const decision = decideAutoResolution(
      baseDiff({ addableFields: [field("region")], overwritableFields: [field("storeNameRaw")] }),
      true
    );
    expect(decision.action).toBe("apply");
    expect(decision.fields.sort()).toEqual(["region", "storeNameRaw"]);
    expect(decision.reason).toBe("claude_sourced_overwrite");
  });
});
