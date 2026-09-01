// Minimal ZIP writer (STORE method, no compression). No dependencies.
// Enough to reproduce AutoReview's "Export all" -> .zip download entirely client-side.
function crc32(bytes) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function writeUint32LE(view, offset, value) {
  view.setUint32(offset, value, true);
}

function makeZip(files) {
  // files: [{ name: "a/b.md", data: Uint8Array }]
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, day } = dosDateTime(now);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const localHeader = new ArrayBuffer(30);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    writeUint32LE(lv, 14, crc);
    writeUint32LE(lv, 18, data.length);
    writeUint32LE(lv, 22, data.length);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);

    chunks.push(new Uint8Array(localHeader), nameBytes, data);

    const centralHeader = new ArrayBuffer(46);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    writeUint32LE(cv, 16, crc);
    writeUint32LE(cv, 20, data.length);
    writeUint32LE(cv, 24, data.length);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    writeUint32LE(cv, 38, 0);
    writeUint32LE(cv, 42, offset);

    central.push(new Uint8Array(centralHeader), nameBytes);
    offset += localHeader.byteLength + nameBytes.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const piece of central) centralSize += piece.length;

  const endRecord = new ArrayBuffer(22);
  const ev = new DataView(endRecord);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  writeUint32LE(ev, 12, centralSize);
  writeUint32LE(ev, 16, centralStart);
  ev.setUint16(20, 0, true);

  const all = [...chunks, ...central, new Uint8Array(endRecord)];
  return new Blob(all, { type: "application/zip" });
}

window.makeZip = makeZip;
