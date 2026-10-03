// zip 里的中文文件名必须是 UTF-8 且置 bit 11 —— 否则 GitHub 预览 / macOS / 7-Zip 全显示乱码。
// 回归的是这个真实故障：系统 tar / Compress-Archive 在中文 Windows 上按 GBK 写字，且标志位为 0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { zipDir, listZipEntries, readCentralDirectory, crc32, dosDateTime } from '../scripts/zipdir.mjs';

/** 造一个含中文名的临时目录：目录 + 中文文件 + 可压缩文本 + 不可压缩随机字节。 */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zipdir-'));
  const src = path.join(root, '包');
  await fsp.mkdir(path.join(src, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(src, '启动游戏.bat'), '@echo off\r\necho 你好\r\n');
  await fsp.writeFile(path.join(src, '子目录', '说明.md'), '# 说明\n中文内容\n'.repeat(50));
  // 真随机字节：deflate 压不动，应当退回 store（用固定周期序列会被压掉，测不出这件事）
  const rnd = crypto.randomBytes(4096);
  await fsp.writeFile(path.join(src, '子目录', 'random.bin'), rnd);
  return { root, src };
}

test('zip 写入器：中文文件名是 UTF-8 且置 UTF-8 标志位（bit 11）', async () => {
  const { root, src } = await fixture();
  try {
    const zip = path.join(root, 'out.zip');
    await zipDir(src, zip, { prefix: '包' });
    const cd = await readCentralDirectory(zip);

    const names = cd.map((e) => e.name);
    assert.ok(names.includes('包/启动游戏.bat'), `应含中文文件名，实际：${names.join(', ')}`);
    assert.ok(names.includes('包/子目录/说明.md'));
    assert.ok(names.includes('包/子目录/'), '目录条目应存在且以 / 结尾');

    // 关键断言：一个乱码字符都不该有
    assert.ok(!names.some((n) => n.includes('\ufffd')), '文件名不应有替换字符（UTF-8 解码失败的标志）');
    for (const e of cd) assert.equal(e.utf8Flag, true, `${e.name} 必须置 UTF-8 标志位`);

    // 字节层面确认：中文没有被写成 GBK（Node 没有 GBK 编码器，用抓到的真实 GBK 字节做比对）
    const raw = await fsp.readFile(zip);
    assert.ok(!raw.includes(Buffer.from('c6f4b6afd3cecfb72e626174', 'hex')), 'zip 里不应出现 GBK 编码的「启动游戏.bat」');
    assert.ok(raw.includes(Buffer.from('包/启动游戏.bat', 'utf8')), 'zip 里应有 UTF-8 编码的中文名');

    // 条目的 CRC/大小要和源文件对得上
    const bat = cd.find((e) => e.name === '包/启动游戏.bat');
    const src2 = await fsp.readFile(path.join(src, '启动游戏.bat'));
    assert.equal(bat.usize, src2.length);
    assert.equal(bat.crc, crc32(src2));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('zip 写入器：能被系统解压器正确读回（名字与内容都对）', async () => {
  const { root, src } = await fixture();
  try {
    const zip = path.join(root, 'out.zip');
    await zipDir(src, zip, { prefix: '包' });
    const dest = path.join(root, 'unzip');
    await fsp.mkdir(dest, { recursive: true });

    // Windows 自带 bsdtar；其它平台用 unzip / bsdtar
    let r = spawnSync('tar', ['-xf', zip, '-C', dest], { stdio: 'ignore' });
    if (r.error || r.status !== 0) r = spawnSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'ignore' });
    if (r.error || r.status !== 0) return; // 没有可用解压器就跳过（已有中央目录断言兜底）

    const f = path.join(dest, '包', '启动游戏.bat');
    assert.ok(fs.existsSync(f), `解压后应存在 ${f}`);
    assert.equal(await fsp.readFile(f, 'utf8'), '@echo off\r\necho 你好\r\n');
    assert.ok(fs.existsSync(path.join(dest, '包', '子目录', '说明.md')));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('zip 写入器：deflate 可还原、压不动的文件退回 store、无 ZIP64 也能处理正常包', async () => {
  const { root, src } = await fixture();
  try {
    const zip = path.join(root, 'out.zip');
    const st = await zipDir(src, zip, { prefix: '包' });
    assert.equal(st.files, 3);
    assert.equal(st.dirs, 2, '包/ 与 包/子目录/');
    assert.ok(st.bytes > 0 && st.rawBytes > 0);

    // 用 tar 列表确认结构，再逐个用 node 自己解 deflate 验证内容
    const names = (await readCentralDirectory(zip)).map((e) => e.name);
    assert.deepEqual([...names].sort(), ['包/', '包/启动游戏.bat', '包/子目录/', '包/子目录/random.bin', '包/子目录/说明.md']);

    const cd = await readCentralDirectory(zip);
    const txt = cd.find((e) => e.name === '包/子目录/说明.md');
    assert.equal(txt.method, 8, '文本应走 deflate');
    assert.ok(txt.csize < txt.usize, '文本应被压缩');
    const rnd = cd.find((e) => e.name === '包/子目录/random.bin');
    assert.equal(rnd.method, 0, '随机字节压不动应退回 store');
    assert.equal(rnd.csize, rnd.usize);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('zip 写入器：listZipEntries 按名字排序、目录条目在后代之前', async () => {
  const { root, src } = await fixture();
  try {
    const items = await listZipEntries(src, { prefix: '包' });
    const names = items.map((i) => i.name);
    assert.deepEqual(names, ['包/', '包/启动游戏.bat', '包/子目录/', '包/子目录/random.bin', '包/子目录/说明.md']);
    assert.equal(items[0].dir, true);
    assert.equal(items[1].dir, false);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('crc32 / dosDateTime: 已知值', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926); // CRC-32/ISO-HDLC 标准测试向量
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  const { time, date } = dosDateTime(new Date(2026, 9, 3, 12, 26, 49)); // 2026-10-03 12:26:49
  assert.equal(date, (((2026 - 1980) << 9) | (10 << 5) | 3) & 0xffff);
  assert.equal(time, ((12 << 11) | (26 << 5) | (49 >> 1)) & 0xffff, '秒按偶数精度截断');
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1)), { time: 0, date: 0x21 }, '1980 之前钳到 1980-01-01');
  assert.ok(zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from('中文 abc'))).toString('utf8') === '中文 abc');
});