export type ImageDimensions = { width: number; height: number; megapixels: number };

function result(width: number, height: number): ImageDimensions {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions");
  }
  return { width, height, megapixels: (width * height) / 1_000_000 };
}

function png(bytes: Buffer) {
  if (bytes.length < 24) throw new Error("Invalid PNG image");
  return result(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function gif(bytes: Buffer) {
  if (bytes.length < 10) throw new Error("Invalid GIF image");
  return result(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function jpeg(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG image");
  let offset = 2;
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker)) {
      if (length < 7) throw new Error("Invalid JPEG frame");
      return result(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  throw new Error("JPEG dimensions not found");
}

function readUInt24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webp(bytes: Buffer) {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw new Error("Invalid WebP image");
  }
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return result(1 + readUInt24LE(bytes, 24), 1 + readUInt24LE(bytes, 27));
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) throw new Error("Invalid lossless WebP image");
    const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return result(width, height);
  }
  if (chunk === "VP8 ") {
    // Lossy WebP frame header: 0x9d 0x01 0x2a followed by 14-bit width/height.
    for (let i = 20; i + 6 < Math.min(bytes.length, 64); i += 1) {
      if (bytes[i] === 0x9d && bytes[i + 1] === 0x01 && bytes[i + 2] === 0x2a) {
        return result(bytes.readUInt16LE(i + 3) & 0x3fff, bytes.readUInt16LE(i + 5) & 0x3fff);
      }
    }
  }
  throw new Error("WebP dimensions not found");
}

export function readImageDimensions(bytes: Buffer, mimeType: string): ImageDimensions {
  const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  switch (mime) {
    case "image/png": return png(bytes);
    case "image/jpeg":
    case "image/jpg": return jpeg(bytes);
    case "image/gif": return gif(bytes);
    case "image/webp": return webp(bytes);
    default: throw new Error(`Unsupported image format: ${mime || "unknown"}`);
  }
}
