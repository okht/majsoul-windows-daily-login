import os from "node:os";
import nodemailer from "nodemailer";
import { credentialStore } from "./credentials.mjs";

export function failureFingerprint(dateKey, kind, phase) {
  return [dateKey, kind, phase].join("\u001f");
}

export async function sendFailureMail(config, failure, dependencies = {}) {
  const store = dependencies.store ?? credentialStore();
  const createTransport =
    dependencies.createTransport ?? nodemailer.createTransport;
  const hostname = dependencies.hostname ?? os.hostname;

  const password = store.get(config.sender);
  if (!password) {
    const error = new Error("Gmail credential is missing.");
    error.code = "GMAIL_CREDENTIAL_MISSING";
    throw error;
  }

  const transport = createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.sender,
      pass: password
    }
  });

  const text = [
    "发生时间：" + failure.time,
    "设备名称：" + hostname(),
    "失败类型：" + failure.kind,
    "当前阶段：" + failure.phase,
    "执行次数：" + failure.attempts,
    "建议操作：" + failure.action,
    "本地日志：" + failure.logPath
  ].join("\n");

  await transport.sendMail({
    from: config.sender,
    to: config.recipient,
    subject: "MajSoulDaily " + failure.dateKey + " " + failure.kind,
    text
  });
}
