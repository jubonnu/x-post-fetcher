import { describe, it, expect } from "vitest";
import { classifyUrl, classifyImageUrl, extractDomain, hostFromText } from "../src/utils/url.ts";

describe("classifyUrl", () => {
  it("#11 App Store / Google Play → app_download", () => {
    expect(classifyUrl("apps.apple.com/jp/app/xxx").urlType).toBe("app_download");
    expect(classifyUrl("https://play.google.com/store/apps/details?id=x").urlType).toBe("app_download");
  });

  it("X投稿URL → x_post", () => {
    expect(classifyUrl("https://x.com/Zabi_pokeka/status/123").urlType).toBe("x_post");
  });

  it("画像URL → image", () => {
    expect(classifyUrl("https://pbs.twimg.com/media/AbC?format=jpg&name=orig").urlType).toBe("image");
    expect(classifyImageUrl("https://pbs.twimg.com/media/AbC?format=jpg&name=orig").urlType).toBe("image");
  });

  it("会員登録系 → membership_registration", () => {
    expect(classifyUrl("https://oretan.membercard.jp/lottery-entry").urlType).toBe("membership_registration");
  });

  it("応募フォーム系 → application", () => {
    expect(classifyUrl("docs.google.com/forms/d/e/1FAI").urlType).toBe("application");
    expect(classifyUrl("t.livepocket.jp/e/abc").urlType).toBe("application");
  });

  it("不明なドメイン → unknown、domain は抽出される", () => {
    const r = classifyUrl("https://example.com/foo");
    expect(r.urlType).toBe("unknown");
    expect(r.domain).toBe("example.com");
  });
});

describe("hostFromText / extractDomain", () => {
  it("表示テキスト（scheme無し・末尾省略）からホスト抽出", () => {
    expect(hostFromText("apps.apple.com/jp/app/…")).toBe("apps.apple.com");
    expect(extractDomain("https://www.example.com/x")).toBe("example.com");
  });
});
