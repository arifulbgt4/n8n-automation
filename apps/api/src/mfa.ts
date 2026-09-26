import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  const source = randomBytes(bytes);
  let bits = "";
  for (const byte of source) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    output += alphabet[parseInt(chunk, 2)];
  }
  return output;
}

function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, counter: number, digits = 6): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(value % 10 ** digits).padStart(digits, "0");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyTotp(secret: string, code: string, nowMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(nowMs / 30_000);
  for (let step = -window; step <= window; step += 1) {
    if (safeEqual(totp(secret, counter + step), code)) return true;
  }
  return false;
}

export function otpAuthUri(account: string, issuer: string, secret: string): string {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
