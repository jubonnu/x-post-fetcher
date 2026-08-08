import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// `@testing-library/jest-dom/vitest`（自動登録サブパス）は、モノレポのhoisting次第で
// このパッケージ自身が解決する`vitest`（ルートにhoistされた別バージョン）へ`expect`を
// 拡張してしまい、実際のテストファイルが使う`vitest`（このワークスペースのローカル版）の
// `expect`には反映されない場合がある（dual-package hazard）。ここで明示的に
// このワークスペースの`expect`へ拡張することで、バージョン解決に依存せず確実に効かせる。
expect.extend(matchers);
