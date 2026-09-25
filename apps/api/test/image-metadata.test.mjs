import assert from "node:assert/strict";
import test from "node:test";
import { readImageDimensions } from "../src/image-metadata.ts";

test("reads PNG dimensions",()=>{
  const bytes=Buffer.alloc(24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes,0);
  bytes.writeUInt32BE(4000,16);
  bytes.writeUInt32BE(2500,20);
  assert.deepEqual(readImageDimensions(bytes,"image/png"),{width:4000,height:2500,megapixels:10});
});

test("reads GIF dimensions",()=>{
  const bytes=Buffer.alloc(10);
  bytes.write("GIF89a",0,"ascii");
  bytes.writeUInt16LE(1920,6);
  bytes.writeUInt16LE(1080,8);
  const dimensions=readImageDimensions(bytes,"image/gif");
  assert.equal(dimensions.width,1920);
  assert.equal(dimensions.height,1080);
  assert.equal(dimensions.megapixels,2.0736);
});

test("reads JPEG SOF dimensions",()=>{
  const bytes=Buffer.from([
    0xff,0xd8,
    0xff,0xc0,0x00,0x11,0x08,
    0x09,0xc4, // height 2500
    0x0f,0xa0, // width 4000
    0x03,0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,
    0xff,0xd9,
  ]);
  const dimensions=readImageDimensions(bytes,"image/jpeg");
  assert.equal(dimensions.width,4000);
  assert.equal(dimensions.height,2500);
  assert.equal(dimensions.megapixels,10);
});

test("rejects unverified image formats",()=>{
  assert.throws(()=>readImageDimensions(Buffer.from("not-an-image"),"image/heic"),/Unsupported image format/);
});
