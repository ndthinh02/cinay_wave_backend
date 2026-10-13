import crypto from "node:crypto";
import { ApiError } from "./errors.js";

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export function validateAvatar(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    throw new ApiError(400, "AVATAR_EMPTY", "Hãy chọn ảnh đại diện.");
  if (bytes.length > AVATAR_MAX_BYTES)
    throw new ApiError(413, "AVATAR_TOO_LARGE", "Ảnh đại diện tối đa 5 MB.");
  const declaredMime = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const mime = declaredMime === "image/jpg" ? "image/jpeg" : declaredMime;
  const png =
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0;
  const jpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.lastIndexOf(Buffer.from([255, 217])) >= 3;
  const webp =
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(4) + 8 === bytes.length;
  const actual = png
    ? "image/png"
    : jpeg
      ? "image/jpeg"
      : webp
        ? "image/webp"
        : null;
  if (!actual || actual !== mime)
    throw new ApiError(
      415,
      "AVATAR_TYPE",
      "Chỉ hỗ trợ ảnh JPG/JPEG, PNG hoặc WebP hợp lệ.",
    );
  return actual;
}

// Remote storage persists across redeploys; credentials never go to Android.
export function avatarStorage(env = process.env) {
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const configured = () =>
    /^[a-zA-Z0-9_-]+$/.test(cloud || "") &&
    Boolean(env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  const signed = (params) =>
    crypto
      .createHash("sha256")
      .update(
        Object.keys(params)
          .sort()
          .map((k) => `${k}=${params[k]}`)
          .join("&") + env.CLOUDINARY_API_SECRET,
      )
      .digest("hex");
  async function request(action, params, bytes, mime) {
    if (!configured())
      throw new ApiError(
        503,
        "AVATAR_STORAGE_UNAVAILABLE",
        "Dịch vụ ảnh đại diện chưa được cấu hình. Bạn vẫn có thể lưu tên.",
      );
    const form = new FormData();
    for (const [key, value] of Object.entries(params))
      form.set(key, String(value));
    form.set("api_key", env.CLOUDINARY_API_KEY);
    form.set("signature", signed(params));
    if (bytes) form.set("file", new Blob([bytes], { type: mime }), "avatar");
    try {
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${cloud}/image/${action}`,
        { method: "POST", body: form, signal: AbortSignal.timeout(20000) },
      );
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new ApiError(
        502,
        "AVATAR_STORAGE_FAILED",
        "Chưa lưu được ảnh đại diện. Thay đổi của bạn được giữ lại để thử lại.",
      );
    }
  }
  return {
    async upload(userId, bytes, mime) {
      const publicId = `cinaywave/avatars/${userId}/${crypto.randomUUID()}`;
      const params = {
        public_id: publicId,
        timestamp: Math.floor(Date.now() / 1000),
        overwrite: "false",
        transformation: "c_fill,g_auto,h_512,w_512/f_jpg/q_auto",
      };
      const result = await request("upload", params, bytes, mime);
      let url;
      try {
        url = new URL(result.secure_url);
      } catch {
        throw new ApiError(
          502,
          "AVATAR_STORAGE_FAILED",
          "Dịch vụ ảnh trả về dữ liệu không hợp lệ. Vui lòng thử lại.",
        );
      }
      if (
        url.protocol !== "https:" ||
        url.hostname !== "res.cloudinary.com" ||
        !url.pathname.startsWith(`/${cloud}/image/upload/`) ||
        result.public_id !== publicId ||
        !result.width ||
        !result.height
      )
        throw new ApiError(
          502,
          "AVATAR_STORAGE_FAILED",
          "Dịch vụ ảnh trả về dữ liệu không hợp lệ. Vui lòng thử lại.",
        );
      return { url: url.href, publicId };
    },
    async remove(publicId) {
      if (!publicId?.startsWith("cinaywave/avatars/")) return;
      await request("destroy", {
        public_id: publicId,
        timestamp: Math.floor(Date.now() / 1000),
        invalidate: "true",
      });
    },
  };
}
