import nodemailer from "nodemailer";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

export type CodePurpose = "register" | "reset";

export function codeMail(purpose: CodePurpose, code: string): { subject: string; text: string } {
  const what = purpose === "register" ? "注册 / sign up" : "重置密码 / password reset";
  return {
    subject: `拍拍 PatPatTap 验证码 ${code}`,
    text:
      `你的验证码（${what}）：${code}\nYour verification code: ${code}\n\n` +
      `10 分钟内有效。若非本人操作请忽略。\nValid for 10 minutes. Ignore this mail if it wasn't you.`,
  };
}
