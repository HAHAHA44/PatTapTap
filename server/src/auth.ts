import crypto from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Stored as "scrypt$N$r$p$salt$hash" (base64). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const key = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +n, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, want);
}

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_DAYS = 90;

export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function newCode(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/** Short-lived access tokens (JWT, HS256). */
export class Tokens {
  private key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }
  sign(userId: string): Promise<string> {
    return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(`${ACCESS_TTL_S}s`).sign(this.key);
  }
  /** User id, or null if the token is invalid or expired. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
}
