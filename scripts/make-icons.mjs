// Génère les icônes PNG de la PWA sans dépendance (maison stylisée sur fond rose pastel).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const bg = [255, 198, 234], fg = [17, 17, 17];
  const s = size / 512;
  const inHouse = (x, y, inset) => {
    // toit : triangle (256,112)-(104,236)-(408,236) ; corps : rectangle 104..408 × 236..400 ; porte 208..304 × 300..400
    const X = x / s, Y = y / s;
    const roof = Y >= 112 + inset && Y <= 236 && Math.abs(X - 256) <= ((Y - 112) / 124) * 152 - inset * 1.2;
    const body = X >= 104 + inset && X <= 408 - inset && Y >= 236 && Y <= 400 - inset;
    return roof || body;
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const X = x / s, Y = y / s;
      const outer = inHouse(x, y, -18);
      const inner = inHouse(x, y, 18);
      const door = X >= 226 && X <= 286 && Y >= 300 && Y <= 400;
      const c = outer && (!inner || door) ? fg : bg;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), png(size));
console.log('Icônes générées.');
