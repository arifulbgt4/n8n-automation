import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

export type EncryptedSecret = Readonly<{
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}>;

export function encryptSecret(
  secret: string,
  key: Buffer,
  keyVersion = "v1"
): EncryptedSecret {
  if (key.length !== 32) throw new Error("Credential encryption key must be 32 bytes.");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  key: Buffer
): string {
  if (key.length !== 32) throw new Error("Credential encryption key must be 32 bytes.");

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
