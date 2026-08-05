/** Minimal stored-method ZIP builder for deterministic offline tests. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value >>> 0);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/**
 * @param {Array<{ name: string, content?: string | Buffer, mode?: number }>} entries
 */
export function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || '', 'utf8');
    const checksum = crc32(content);
    const directory = entry.name.endsWith('/');
    const mode = entry.mode ?? (directory ? 0o40755 : 0o100644);
    const flags = 0x0800;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(content.length),
      u32(content.length),
      u16(name.length),
      u16(0),
      name,
      content,
    ]);
    localParts.push(local);

    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(0x0314),
      u16(20),
      u16(flags),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(content.length),
      u32(content.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32((mode << 16) >>> 0),
      u32(localOffset),
      name,
    ]));
    localOffset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(localOffset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}
