/**
 * 图片输入校验（SDK ImageContent 形态）：`{type:"image", data(base64), mimeType}`。
 * prompt / steer / follow-up 三条通道共用；独立于路由层，会话桥各模块直接复用。
 */
export type ImageInput = { type: "image"; data: string; mimeType: string };

/**
 * 校验并归一化图片数组；不合法时返回**错误文案**（string），合法返回归一化数组——
 * 调用方用 `typeof images === "string"` 分支处理，避免为每种错误单独建模。
 */
export function parseImages(raw: unknown): ImageInput[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return "images must be an array";
  const out: ImageInput[] = [];
  for (const img of raw) {
    if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") {
      return "each image needs data (base64 string) and mimeType";
    }
    // 只解码前 32 字符做 base64 合法性抽查，避免为整张大图付解码成本
    try {
      atob(img.data.slice(0, 32));
    } catch {
      return "image data must be base64";
    }
    out.push({ type: "image", data: img.data, mimeType: String(img.mimeType) });
  }
  return out;
}
