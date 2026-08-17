import nodemailer from "nodemailer";

let transporter = null;

export function initMailer() {
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "1",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
        : undefined,
    });
  }
}

export function isMailConfigured() {
  return !!transporter;
}

export async function sendEmail({ to, subject, text }) {
  if (!transporter) {
    console.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || "Bookking <no-reply@bookking.local>",
    to,
    subject,
    text,
  });
}
