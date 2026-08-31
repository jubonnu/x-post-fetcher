// サブパスではなく本体からimportする（package.jsonのconditional exportsで
// workerd実行時は"workerd"ビルド、Node実行時（vitest等）は"node"ビルドへ自動的に振り分けられる）。
import { PhotonImage, SamplingFilter, resize } from "@cf-wasm/photon";

/**
 * 管理画面(120x120px)・モバイル(最大82x106px)ともにこれより大きく表示することは無いため、
 * @3x相当の余裕を持たせて長辺をこのpxに制限する。すでにこれ以下なら縮小しない（拡大はしない）。
 */
const MAX_THUMBNAIL_DIMENSION = 480;
const JPEG_QUALITY = 85;

/**
 * 商品画像をサムネイル用にリサイズする。元画像は表示に使う予定が無いため保持しない
 * （imageUrlは1つのみ・別途original/thumbnailを分けて保存する設計にはしていない）。
 * デコード・リサイズに失敗した場合（テスト用のダミーバイト列や壊れた画像等）は、
 * アップロード自体を失敗させず元のバイト列をそのまま返す（ベストエフォート）。
 */
export function resizeImageForThumbnail(bytes: ArrayBuffer, contentType: string): { bytes: Uint8Array; contentType: string } {
  let input: PhotonImage | undefined;
  let output: PhotonImage | undefined;
  try {
    input = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
    const width = input.get_width();
    const height = input.get_height();
    const longestSide = Math.max(width, height);
    if (!Number.isFinite(longestSide) || longestSide <= 0 || longestSide <= MAX_THUMBNAIL_DIMENSION) {
      return { bytes: new Uint8Array(bytes), contentType };
    }

    const scale = MAX_THUMBNAIL_DIMENSION / longestSide;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    output = resize(input, targetWidth, targetHeight, SamplingFilter.Lanczos3);

    return { bytes: encodeBytes(output, contentType), contentType };
  } catch (e) {
    console.error(
      JSON.stringify({ event: "image_thumbnail_resize_failed", message: e instanceof Error ? e.message : String(e) })
    );
    return { bytes: new Uint8Array(bytes), contentType };
  } finally {
    input?.free();
    output?.free();
  }
}

function encodeBytes(image: PhotonImage, contentType: string): Uint8Array {
  if (contentType === "image/png") return image.get_bytes();
  if (contentType === "image/webp") return image.get_bytes_webp();
  return image.get_bytes_jpeg(JPEG_QUALITY);
}
