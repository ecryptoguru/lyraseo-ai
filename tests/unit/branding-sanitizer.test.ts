import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import sharp from "../../apps/lyraseo-web/node_modules/sharp";
import { sanitizeBrandLogo } from "../../apps/lyraseo-web/src/server/branding/sanitize";
it("accepts pixels only and strips metadata into bounded canonical PNG", async () => {
  const jpeg = await sharp({
    create: { width: 40, height: 20, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata()
    .toBuffer();
  const sanitized = await sanitizeBrandLogo(jpeg, "image/jpeg");
  expect(sanitized.mime).toBe("image/png");
  expect(sanitized.width).toBe(40);
  expect(sanitized.height).toBe(20);
  expect(sanitized.sha256).toBe(
    createHash("sha256").update(sanitized.bytes).digest("hex"),
  );
  const metadata = await sharp(sanitized.bytes).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
});
it("rejects active formats, signature mismatches, malformed and over-bound inputs", async () => {
  for (const [bytes, mime] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"],
    [Buffer.from("<html>"), "image/png"],
    [Buffer.alloc(512 * 1024 + 1), "image/png"],
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
  ] as const)
    await expect(sanitizeBrandLogo(bytes, mime)).rejects.toThrow(
      "INVALID_BRAND_LOGO",
    );
  const jpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  await expect(sanitizeBrandLogo(jpeg, "image/png")).rejects.toThrow(
    "INVALID_BRAND_LOGO",
  );
  const huge = await sharp({
    create: { width: 2100, height: 2000, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(sanitizeBrandLogo(huge, "image/png")).rejects.toThrow(
    "INVALID_BRAND_LOGO",
  );
});
it("rejects active trailing polyglots and PNG animation control chunks", async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(
    sanitizeBrandLogo(
      Buffer.concat([png, Buffer.from("<html>active</html>")]),
      "image/png",
    ),
  ).rejects.toThrow("INVALID_BRAND_LOGO");
  const { crc32 } = await import("node:zlib");
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2);
  const type = Buffer.from("acTL");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const animated = Buffer.concat([
    png.subarray(0, 33),
    len,
    type,
    data,
    crc,
    png.subarray(33),
  ]);
  await expect(sanitizeBrandLogo(animated, "image/png")).rejects.toThrow(
    "INVALID_BRAND_LOGO",
  );
});
