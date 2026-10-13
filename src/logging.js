import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const actions = new Set([
  "register",
  "login",
  "resend",
  "verify",
  "google",
  "refresh",
  "logout",
]);
export function aiLog(event, fields = {}, level = "info") {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context.getStore(),
  };
  for (const key of [
    "status",
    "durationMs",
    "errorCode",
    "stage",
    "providerStatus",
    "providerCode",
    "providerType",
    "providerParam",
    "movieCount",
  ]) {
    if (fields[key] !== undefined) record[key] = fields[key];
  }
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export function aiRequestLogger(req, res, next) {
  if (req.method !== "POST" || req.path !== "/api/ai/chat") return next();
  const request = { requestId: crypto.randomUUID() };
  const started = performance.now();
  let finished = false;
  res.setHeader("X-Request-ID", request.requestId);
  context.run(request, () => {
    aiLog("ai.request");
    res.once("finish", () => {
      finished = true;
      context.run(request, () =>
        aiLog(
          "ai.result",
          {
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
            errorCode:
              res.locals.authErrorCode ||
              (res.statusCode === 429
                ? "AI_RATE_LIMIT"
                : res.statusCode >= 400
                  ? "REQUEST_FAILED"
                  : undefined),
          },
          res.statusCode >= 500
            ? "error"
            : res.statusCode >= 400
              ? "warn"
              : "info",
        ),
      );
    });
    res.once("close", () => {
      if (!finished)
        context.run(request, () =>
          aiLog(
            "ai.aborted",
            { durationMs: Math.round(performance.now() - started) },
            "warn",
          ),
        );
    });
    next();
  });
}
export function maskedEmail(value) {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return `${parts[0].slice(0, 2)}***@${parts[1].replace(/[\r\n]/g, "").slice(0, 100)}`;
}
// Explicit fields only: never serialize request bodies, headers or Error objects.
export function authLog(event, fields = {}, level = "info") {
  const current = context.getStore() || {};
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...current,
  };
  for (const key of [
    "email",
    "userId",
    "accountState",
    "status",
    "durationMs",
    "errorCode",
    "smtpCode",
    "smtpResponseCode",
    "smtpCommand",
    "hint",
  ]) {
    if (fields[key] !== undefined) record[key] = fields[key];
  }
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}
export function authRequestLogger(req, res, next) {
  const match = /^\/api\/auth\/([a-z]+)$/.exec(req.path);
  if (req.method !== "POST" || !actions.has(match?.[1])) return next();
  const request = { requestId: crypto.randomUUID(), action: match[1] };
  const started = performance.now();
  let finished = false;
  res.setHeader("X-Request-ID", request.requestId);
  context.run(request, () => {
    authLog("auth.request");
    res.once("finish", () => {
      finished = true;
      context.run(request, () =>
        authLog(
          "auth.result",
          {
            email: maskedEmail(req.body?.email),
            userId: res.locals.authUserId,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
            errorCode:
              res.locals.authErrorCode ||
              (res.statusCode === 429
                ? "RATE_LIMIT"
                : res.statusCode >= 400
                  ? "REQUEST_FAILED"
                  : undefined),
          },
          res.statusCode >= 500
            ? "error"
            : res.statusCode >= 400
              ? "warn"
              : "info",
        ),
      );
    });
    res.once("close", () => {
      if (!finished)
        context.run(request, () =>
          authLog(
            "auth.aborted",
            { durationMs: Math.round(performance.now() - started) },
            "warn",
          ),
        );
    });
    next();
  });
}
export function smtpFailure(error) {
  const codes = new Set([
    "EAUTH",
    "ECONNECTION",
    "ETIMEDOUT",
    "ESOCKET",
    "ETLS",
    "EDNS",
    "EENVELOPE",
    "EMESSAGE",
    "ENOAUTH",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
  ]);
  const smtpCode = codes.has(error?.code) ? error.code : "UNKNOWN";
  const smtpResponseCode =
    Number.isInteger(error?.responseCode) &&
    error.responseCode >= 100 &&
    error.responseCode <= 599
      ? error.responseCode
      : undefined;
  const command =
    typeof error?.command === "string" ? error.command.toUpperCase() : "";
  const smtpCommand = command.startsWith("AUTH")
    ? "AUTH"
    : [
          "CONN",
          "EHLO",
          "HELO",
          "STARTTLS",
          "MAIL FROM",
          "RCPT TO",
          "DATA",
        ].includes(command)
      ? command
      : undefined;
  const hint =
    smtpCode === "EAUTH" || smtpResponseCode === 535
      ? "Kiểm tra SMTP_USER, SMTP_PASSWORD/app password và quyền SMTP của nhà cung cấp."
      : [
            "ECONNECTION",
            "ETIMEDOUT",
            "ESOCKET",
            "ECONNREFUSED",
            "ECONNRESET",
            "EDNS",
            "ENOTFOUND",
            "EAI_AGAIN",
          ].includes(smtpCode)
        ? "Kiểm tra SMTP_HOST, cổng, DNS, firewall và kết nối mạng của server."
        : smtpCode === "ETLS"
          ? "Kiểm tra TLS: cổng 587 dùng STARTTLS; cổng 465 dùng SMTP_SECURE=true."
          : smtpCode === "EENVELOPE"
            ? "Kiểm tra địa chỉ SMTP_FROM, người nhận và quyền gửi của tài khoản."
            : "Kiểm tra cấu hình SMTP và trạng thái dịch vụ email.";
  return { smtpCode, smtpResponseCode, smtpCommand, hint };
}
