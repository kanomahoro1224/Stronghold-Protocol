// 自己写 zip，而不是调系统 tar / Compress-Archive。
//
// 原因：Windows 上的 bsdtar 与 Compress-Archive 会按**当前 ANSI 代码页**（中文系统 = GBK）写文件名，并且不置
// UTF-8 标志位（general purpose bit 11）。于是包内「启动游戏.bat」在字节层面是 GBK，只有同样按 GBK 读名的解压器
// 才显示正常 —— GitHub 的压缩包预览、macOS、7-Zip、多数现代解压器一律按 UTF-8 读，全部显示乱码。
//
// 这里统一按 UTF-8 编码名字并**始终置 bit 11**，所以 Windows / macOS / Linux 打出来的包在哪儿看都正常。
// 只实现 ZIP（deflate / store + 中央目录 + EOCD），不实现 ZIP64：超过 4 GB 或 65535 个条目会直接报错而不是
// 悄悄产出一个坏包。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;   // bit 11：文件名/注释为 UTF-8
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const LIMIT_32 = 0xffffffff;
const LIMIT_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/** 标准 CRC-32（IEEE 802.3），zip 用的那个。 */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/** Date → DOS 时间/日期（zip 头里的 2+2 字节，秒只保留偶数精度）。 */
export function dosDateTime(d) {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: 0x21 }; // 1980-01-01
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * 递归列出 `dir` 下的条目，深度优先、按名字排序（打包结果稳定，便于比对）。
 * 名字一律用 `/` 分隔的 zip 风格相对路径；目录条目以 `/` 结尾。
 * @param {string} dir
 * @param {{ prefix?: string }} [o] prefix 是写进 zip 的顶层目录名（默认取 dir 的 basename，传 '' 表示不要顶层目录）
 * @returns {Promise<{ name: string, abs: string, dir: boolean, mtime: Date }[]>}
 */
export async function listZipEntries(dir, { prefix = path.basename(dir) } = {}) {
  const out = [];
  const walk = async (abs, rel) => {
    const items = await fsp.readdir(abs, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (rel) out.push({ name: `${rel}/`, abs, dir: true, mtime: (await fsp.stat(abs)).mtime });
    for (const it of items) {
      const childAbs = path.join(abs, it.name);
      const childRel = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(childAbs, childRel);
      else if (it.isFile()) out.push({ name: childRel, abs: childAbs, dir: false, mtime: (await fsp.stat(childAbs)).mtime });
    }
  };
  await walk(dir, prefix);
  return out;
}

/**
 * 把 `srcDir` 压成 `zipPath`（含顶层目录 `prefix`，与原来 `tar -C <parent> <basename>` 的结构一致）。
 * @param {string} srcDir
 * @param {string} zipPath
 * @param {{ prefix?: string, level?: number, onProgress?: (done: number, total: number, name: string) => void }} [o]
 * @returns {Promise<{ files: number, dirs: number, bytes: number, entries: number }>}
 */
export async function zipDir(srcDir, zipPath, { prefix = path.basename(srcDir), level = 6, onProgress } = {}) {
  const items = await listZipEntries(srcDir, { prefix });
  if (items.length > LIMIT_ENTRIES) throw new Error(`条目数 ${items.length} 超过 65535，需要 ZIP64（本实现不支持）`);

  const tmp = `${zipPath}.part`;
  await fsp.rm(tmp, { force: true });
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const out = fs.createWriteStream(tmp);

  let offset = 0;
  let files = 0;
  let dirs = 0;
  let rawBytes = 0;
  const central = [];

  const push = async (buf) => {
    offset += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  };

  const localHeader = (nameBytes, method, time, date, crc, csize, usize) => {
    const h = Buffer.alloc(30 + nameBytes.length);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(20, 4);              // 需要的版本：2.0
    h.writeUInt16LE(FLAG_UTF8, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(nameBytes.length, 26);
    h.writeUInt16LE(0, 28);              // extra 长度
    nameBytes.copy(h, 30);
    return h;
  };

  try {
    let done = 0;
    for (const it of items) {
      const nameBytes = Buffer.from(it.name, 'utf8');
      const { time, date } = dosDateTime(it.mtime);
      const start = offset;
      if (it.dir) {
        dirs++;
        await push(localHeader(nameBytes, METHOD_STORE, time, date, 0, 0, 0));
        // 目录：mode 040755 + MS-DOS 目录位
        central.push({ nameBytes, method: METHOD_STORE, time, date, crc: 0, csize: 0, usize: 0, start, attrs: ((0o040755 << 16) | 0x10) >>> 0 });
      } else {
        const data = await fsp.readFile(it.abs);
        rawBytes += data.length;
        const crc = crc32(data);
        let method = level > 0 ? METHOD_DEFLATE : METHOD_STORE;
        let body = method === METHOD_DEFLATE ? zlib.deflateRawSync(data, { level }) : data;
        // 压不动就存原文（比如 mp3 / png / zip），别让包白变大
        if (method === METHOD_DEFLATE && body.length >= data.length) { method = METHOD_STORE; body = data; }
        await push(localHeader(nameBytes, method, time, date, crc, body.length, data.length));
        await push(body);
        files++;
        // 文件：mode 0100644
        central.push({ nameBytes, method, time, date, crc, csize: body.length, usize: data.length, start, attrs: (0o100644 << 16) >>> 0 });
      }
      onProgress?.(++done, items.length, it.name);
    }

    // 中央目录
    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46 + e.nameBytes.length);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(0x031e, 4);        // 制作版本：UNIX + 3.0
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBytes.length, 28);
      h.writeUInt16LE(0, 30);            // extra
      h.writeUInt16LE(0, 32);            // 注释
      h.writeUInt16LE(0, 34);            // 起始磁盘
      h.writeUInt16LE(0, 36);            // 内部属性
      h.writeUInt32LE(e.attrs, 38);
      h.writeUInt32LE(e.start, 42);
      e.nameBytes.copy(h, 46);
      await push(h);
    }
    const cdSize = offset - cdStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await push(eocd);

    if (offset > LIMIT_32 || cdStart > LIMIT_32) throw new Error('产物超过 4 GB，需要 ZIP64（本实现不支持）');

    await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
    await fsp.rm(zipPath, { force: true });
    await fsp.rename(tmp, zipPath);
    return { files, dirs, bytes: offset, rawBytes, entries: central.length };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * 读一个 zip 的中央目录（仅用于校验：名字、UTF-8 标志、CRC）。
 * @param {string} zipPath
 * @returns {Promise<{ name: string, utf8Flag: boolean, method: number, crc: number, csize: number, usize: number }[]>}
 */
export async function readCentralDirectory(zipPath) {
  const buf = await fsp.readFile(zipPath);
  const out = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== SIG_CENTRAL) continue;
    const flags = buf.readUInt16LE(i + 8);
    const nameLen = buf.readUInt16LE(i + 28);
    out.push({
      name: buf.subarray(i + 46, i + 46 + nameLen).toString('utf8'),
      utf8Flag: (flags & FLAG_UTF8) !== 0,
      method: buf.readUInt16LE(i + 10),
      crc: buf.readUInt32LE(i + 16),
      csize: buf.readUInt32LE(i + 20),
      usize: buf.readUInt32LE(i + 24),
    });
    i += 45 + nameLen;
  }
  return out;
}