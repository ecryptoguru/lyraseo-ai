import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import type { SanitizedBrandLogo } from "@lyraseo/db/branding";
export const BRAND_UPLOAD_MAX_BYTES = 512 * 1024;
export const BRAND_DECODE_MAX_PIXELS = 4_000_000;
export const BRAND_OUTPUT_MAX_BYTES = 64 * 1024;
export const BRAND_DECODE_DEADLINE_MS = 3000;
const require = createRequire(import.meta.url);
/** Fixed program and package path only; user bytes travel on stdin, never code or filenames. */
const program = `import {createRequire} from 'node:module';const require=createRequire(process.cwd()+'/branding-worker.cjs');const sharp=require(process.argv[1]);sharp.cache(false);sharp.concurrency(1);const chunks=[];let size=0;for await(const c of process.stdin){size+=c.length;if(size>524288)process.exit(2);chunks.push(c);}const input=Buffer.concat(chunks);try{const image=sharp(input,{failOn:'warning',limitInputPixels:4000000,limitInputChannels:4,animated:false});const meta=await image.metadata();if(!['png','jpeg'].includes(meta.format)||!meta.width||!meta.height||meta.width*meta.height>4000000||(meta.pages??1)!==1||meta.delay?.length||meta.loop!==undefined)process.exit(2);const {data,info}=await image.autoOrient().resize({width:512,height:256,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9,adaptiveFiltering:false}).timeout({seconds:2}).toBuffer({resolveWithObject:true});if(data.length>65536)process.exit(2);process.stdout.write(JSON.stringify({width:info.width,height:info.height,base64:data.toString('base64')}));}catch{process.exit(2);}`;
export async function sanitizeBrandLogo(
  input: Uint8Array,
  mime: string,
): Promise<SanitizedBrandLogo> {
  const bytes = Buffer.from(input);
  if (
    !bytes.length ||
    bytes.length > BRAND_UPLOAD_MAX_BYTES ||
    !["image/png", "image/jpeg"].includes(mime)
  )
    throw Error("INVALID_BRAND_LOGO");
  const png =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  if ((mime === "image/png" && !png) || (mime === "image/jpeg" && !jpeg))
    throw Error("INVALID_BRAND_LOGO");
  if (png) {
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        end = offset + 12 + length;
      if (end > bytes.length) throw Error("INVALID_BRAND_LOGO");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        !/^[a-zA-Z]{4}$/.test(type) ||
        ["acTL", "fcTL", "fdAT"].includes(type) ||
        crc32(bytes.subarray(offset + 4, end - 4)) !==
          bytes.readUInt32BE(end - 4)
      )
        throw Error("INVALID_BRAND_LOGO");
      if (offset === 8 && (type !== "IHDR" || length !== 13))
        throw Error("INVALID_BRAND_LOGO");
      if (type === "IEND") {
        if (length !== 0 || end !== bytes.length)
          throw Error("INVALID_BRAND_LOGO");
        ended = true;
        break;
      }
      offset = end;
    }
    if (!ended) throw Error("INVALID_BRAND_LOGO");
  }
  if (jpeg && (bytes.at(-2) !== 255 || bytes.at(-1) !== 217))
    throw Error("INVALID_BRAND_LOGO");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--input-type=module",
        "-e",
        program,
        require.resolve("sharp"),
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
      },
    );
    const output: Buffer[] = [];
    let length = 0,
      settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(Error("INVALID_BRAND_LOGO"));
    };
    const timer = setTimeout(fail, BRAND_DECODE_DEADLINE_MS);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 100000) fail();
      else output.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const value = JSON.parse(Buffer.concat(output).toString("utf8")),
          canonical = Buffer.from(value.base64, "base64");
        if (
          canonical.length > BRAND_OUTPUT_MAX_BYTES ||
          !Number.isInteger(value.width) ||
          value.width < 1 ||
          value.width > 512 ||
          !Number.isInteger(value.height) ||
          value.height < 1 ||
          value.height > 256
        )
          throw Error();
        settled = true;
        clearTimeout(timer);
        resolve({
          bytes: canonical,
          mime: "image/png",
          width: value.width,
          height: value.height,
          sha256: createHash("sha256").update(canonical).digest("hex"),
        });
      } catch {
        fail();
      }
    });
    child.stdin.end(bytes);
  });
}
