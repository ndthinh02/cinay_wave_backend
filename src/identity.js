import crypto from "node:crypto";
import { createRequire } from "node:module";
import { User } from "./models.js";
import { ApiError } from "./errors.js";
import { authLog, maskedEmail, smtpFailure } from "./logging.js";

export const otpDigest = (secret, email, code) =>
  crypto.createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
export function emailSender(env = process.env) {
  const configured = () =>
    Boolean(
      env.SMTP_HOST && env.SMTP_FROM && env.SMTP_USER && env.SMTP_PASSWORD,
    );
  return {
    configured,
    async send(email, code) {
      if (!configured())
        throw new ApiError(
          503,
          "EMAIL_NOT_CONFIGURED",
          "Dịch vụ email chưa được cấu hình. Vui lòng thử lại sau.",
        );
      let nodemailer;
      try {
        const require = createRequire(import.meta.url);
        if (
          Number(require("nodemailer/package.json").version.split(".")[0]) < 10
        )
          throw new Error();
        nodemailer = (await import("nodemailer")).default;
      } catch {
        throw new ApiError(
          503,
          "EMAIL_DEPENDENCY_UNAVAILABLE",
          "Dịch vụ email đang được cập nhật. Vui lòng thử lại sau.",
        );
      }
      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: env.SMTP_SECURE === "true",
        requireTLS: env.SMTP_SECURE !== "true",
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        connectionTimeout: 10000,
        socketTimeout: 15000,
      });
      try {
        await transport.sendMail({
          from: env.SMTP_FROM,
          to: email,
          subject: "Xác nhận email CinayWave",
          text: `Mã xác nhận CinayWave: ${code}. Có hiệu lực trong 5 phút. Không chia sẻ mã này.`,
          html: `<div style="background:#101116;padding:32px;font-family:Arial,sans-serif;color:#f1f0ed"><div style="max-width:460px;margin:auto"><p style="color:#d7b47b;letter-spacing:3px">CINAYWAVE</p><h1>Xác nhận email</h1><p>Một bước nữa để lưu những câu chuyện bạn yêu thích.</p><p style="font-size:36px;letter-spacing:8px;padding:24px;background:#20232b;border-radius:16px;text-align:center">${code}</p><p>Mã có hiệu lực trong 5 phút. Không chia sẻ mã này.</p><p style="color:#aaa">Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này.</p></div></div>`,
        });
      } catch (error) {
        authLog(
          "otp.smtp_failed",
          { email: maskedEmail(email), ...smtpFailure(error) },
          "error",
        );
        throw new ApiError(
          503,
          "EMAIL_SEND_FAILED",
          "Chưa gửi được email xác nhận. Vui lòng thử lại.",
        );
      } finally {
        transport.close();
      }
    },
  };
}
export async function sendOtp(user, secret, mailer) {
  if (!mailer.configured())
    throw new ApiError(
      503,
      "EMAIL_NOT_CONFIGURED",
      "Dịch vụ email chưa được cấu hình. Vui lòng thử lại sau.",
    );
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
  const hash = otpDigest(secret, user.email, code);
  const now = new Date();
  const reserved = await User.findOneAndUpdate(
    {
      _id: user._id,
      emailVerified: { $ne: true },
      $or: [
        { otpSentAt: { $lte: new Date(now.getTime() - 60000) } },
        { otpSentAt: { $exists: false } },
      ],
    },
    {
      $set: {
        otpHash: hash,
        otpExpiresAt: new Date(now.getTime() + 300000),
        otpAttempts: 0,
        otpSentAt: now,
      },
    },
    { new: true },
  );
  if (!reserved)
    throw new ApiError(
      429,
      "OTP_COOLDOWN",
      "Vui lòng chờ 60 giây trước khi gửi lại mã.",
    );
  authLog("otp.send_started", {
    email: maskedEmail(user.email),
    userId: String(user._id),
    accountState: "pending_email_verification",
  });
  try {
    await mailer.send(user.email, code);
    authLog("otp.sent", {
      email: maskedEmail(user.email),
      userId: String(user._id),
    });
  } catch (e) {
    authLog(
      "otp.send_failed",
      {
        email: maskedEmail(user.email),
        userId: String(user._id),
        errorCode: e instanceof ApiError ? e.code : "EMAIL_SEND_FAILED",
        accountState: "pending_email_verification",
      },
      "error",
    );
    await User.updateOne(
      { _id: user._id, otpHash: hash },
      { $unset: { otpHash: 1, otpExpiresAt: 1, otpSentAt: 1 } },
    );
    throw e;
  }
  return {
    email: user.email,
    resendAfter: Math.max(
      0,
      Math.ceil((now.getTime() + 60000 - Date.now()) / 1000),
    ),
    expiresIn: Math.max(
      0,
      Math.floor((now.getTime() + 300000 - Date.now()) / 1000),
    ),
  };
}
export async function verifyOtp(email, code, secret) {
  const now = new Date();
  // Reserve an attempt atomically. Concurrent requests cannot exceed five attempts.
  const pending = await User.findOneAndUpdate(
    {
      email,
      emailVerified: { $ne: true },
      otpHash: { $exists: true },
      otpExpiresAt: { $gt: now },
      otpAttempts: { $lt: 5 },
    },
    { $inc: { otpAttempts: 1 } },
    { new: true },
  );
  if (!pending)
    throw new ApiError(
      400,
      "OTP_EXPIRED",
      "Mã đã hết hạn hoặc vượt quá 5 lần thử. Hãy gửi lại mã.",
    );
  const actual = Buffer.from(otpDigest(secret, email, code), "hex");
  const expected = Buffer.from(pending.otpHash, "hex");
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  )
    throw new ApiError(
      400,
      "OTP_INVALID",
      "Mã xác nhận không đúng. Vui lòng kiểm tra lại.",
    );
  // Exact hash guards against resend races; consuming it and verifying are one write.
  const verified = await User.findOneAndUpdate(
    {
      _id: pending._id,
      emailVerified: { $ne: true },
      otpHash: pending.otpHash,
      otpExpiresAt: { $gt: new Date() },
      otpAttempts: { $lte: 5 },
    },
    {
      $set: { emailVerified: true },
      $unset: { otpHash: 1, otpExpiresAt: 1, otpSentAt: 1, otpAttempts: 1 },
    },
    { new: true },
  );
  if (!verified)
    throw new ApiError(
      400,
      "OTP_USED",
      "Mã đã được sử dụng hoặc thay đổi. Hãy đăng nhập hoặc gửi lại mã.",
    );
  return verified;
}
let googleClient;
function identityClient() {
  if (!googleClient) {
    try {
      const { OAuth2Client } = createRequire(import.meta.url)(
        "google-auth-library",
      );
      googleClient = new OAuth2Client({
        transporterOptions: { timeout: 10000, retry: false },
      });
    } catch {
      throw new ApiError(
        503,
        "GOOGLE_UNAVAILABLE",
        "Dịch vụ Google chưa sẵn sàng. Vui lòng thử lại hoặc dùng email.",
      );
    }
  }
  return googleClient;
}
export async function googleIdentity(
  idToken,
  audience = process.env.GOOGLE_WEB_CLIENT_ID,
  client,
) {
  if (!audience)
    throw new ApiError(
      503,
      "GOOGLE_NOT_CONFIGURED",
      "Đăng nhập Google chưa được cấu hình. Vui lòng dùng email.",
    );
  const verifier = client || identityClient();
  try {
    const ticket = await verifier.verifyIdToken({ idToken, audience });
    const p = ticket.getPayload();
    if (
      typeof p?.sub !== "string" ||
      !p.sub ||
      typeof p.email !== "string" ||
      p.email_verified !== true ||
      p.aud !== audience ||
      typeof p.exp !== "number" ||
      p.exp * 1000 <= Date.now()
    )
      throw new Error();
    const name =
      typeof p.name === "string" && p.name.trim()
        ? p.name.trim()
        : p.email.split("@")[0];
    return {
      subject: p.sub,
      email: p.email.trim().toLowerCase(),
      name: name.slice(0, 80),
    };
  } catch (error) {
    if (
      [
        "ETIMEDOUT",
        "ECONNRESET",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
      ].includes(error?.code) ||
      error?.response?.status >= 500 ||
      (error?.name === "GaxiosError" && !error.response)
    ) {
      throw new ApiError(
        503,
        "GOOGLE_UNAVAILABLE",
        "Chưa kết nối được dịch vụ Google. Vui lòng thử lại.",
      );
    }
    throw new ApiError(
      401,
      "GOOGLE_INVALID",
      "Không xác minh được tài khoản Google. Vui lòng thử lại.",
    );
  }
}
