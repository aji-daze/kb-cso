// テスト用の MP3 を作る。
// 中身は「ID3v2.3 タグ（TIT2/TPE1/TALB/TRCK）＋ 無音の MPEG-1 Layer III フレームを
// 指定秒数ぶん並べたもの」。128kbps・44100Hz・モノラル。
//
// 無音フレームの作り方: side info の part2_3_length を 0（＝両グラニュールとも
// ハフマンデータ 0 ビット）にすると、そのグラニュールのスペクトルは全部ゼロになり
// 音は鳴らない。main_data_begin も 0 にしておけば前のフレームのビットリザーバを
// 参照しないので、side info を全部ゼロバイトにするだけで有効な無音フレームになる
// （実データを積む本体のバイトは再生に関係なく、自由に使ってよい）。

const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = 1152;
const BITRATE_KBPS = 128;
// 128kbps・44100Hz・Layer III のフレーム長（パディング無し）
const FRAME_LEN = Math.floor((144 * BITRATE_KBPS * 1000) / SAMPLE_RATE); // 417
const SIDE_INFO_LEN = 17; // MPEG-1・モノラル
const MAIN_DATA_LEN = FRAME_LEN - 4 - SIDE_INFO_LEN;

// FF FB 90 C0 = MPEG-1 Layer III・CRC無し・128kbps・44100Hz・パディング無し・モノラル
const FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc0]);

function buildAudioFrames(seconds, trackNo) {
  const frameCount = Math.max(1, Math.round((seconds * SAMPLE_RATE) / SAMPLES_PER_FRAME));
  const out = Buffer.alloc(FRAME_LEN * frameCount); // ゼロ初期化＝side info もゼロでOK
  for (let i = 0; i < frameCount; i++) {
    const off = i * FRAME_LEN;
    FRAME_HEADER.copy(out, off);
    // 中身が毎回変わるように、本体（main_data。再生には関係しない領域）に
    // trackNo 由来の値を混ぜておく（重複スキップ機能を誤爆させないため）
    const mainDataOff = off + 4 + SIDE_INFO_LEN;
    out[mainDataOff] = (trackNo * 31 + i) & 0xff;
    out[mainDataOff + 1] = (trackNo * 7) & 0xff;
  }
  return out;
}

function textFrame(id, value) {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(String(value), 'latin1')]); // encoding 0 = ISO-8859-1
  const head = Buffer.alloc(10);
  head.write(id, 0, 4, 'ascii');
  head.writeUInt32BE(body.length, 4); // ID3v2.3 はふつうの32bit（syncsafeではない）
  head.writeUInt16BE(0, 8); // flags
  return Buffer.concat([head, body]);
}

function buildId3v2_3({ title, artist, album, trackNo }) {
  const frames = Buffer.concat([
    textFrame('TIT2', title || ''),
    textFrame('TPE1', artist || ''),
    textFrame('TALB', album || ''),
    textFrame('TRCK', String(trackNo || 1)),
  ]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = 3; // major version = ID3v2.3
  header[4] = 0; // revision
  header[5] = 0; // flags
  const size = frames.length;
  header[6] = (size >>> 21) & 0x7f;
  header[7] = (size >>> 14) & 0x7f;
  header[8] = (size >>> 7) & 0x7f;
  header[9] = size & 0x7f;
  return Buffer.concat([header, frames]);
}

// { title, artist, album, trackNo = 1, seconds = 5 } -> Buffer
export function makeMp3({ title, artist, album, trackNo = 1, seconds = 5 }) {
  const id3 = buildId3v2_3({ title, artist, album, trackNo });
  const audio = buildAudioFrames(seconds, trackNo);
  return Buffer.concat([id3, audio]);
}

// 生成した Buffer をブラウザの <audio> に食わせて、loadedmetadata が発火し
// duration が指定秒数の ±1 秒に入ることを確かめる（自己検証）。
export async function selfCheckInBrowser(page, buf, expectedSeconds) {
  const b64 = buf.toString('base64');
  const duration = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const d = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('loadedmetadata timeout')), 8000);
      a.addEventListener(
        'loadedmetadata',
        () => {
          clearTimeout(t);
          resolve(a.duration);
        },
        { once: true }
      );
      a.addEventListener(
        'error',
        () => {
          clearTimeout(t);
          reject(new Error('audio error'));
        },
        { once: true }
      );
      a.src = url;
    });
    URL.revokeObjectURL(url);
    return d;
  }, b64);
  const ok = Number.isFinite(duration) && Math.abs(duration - expectedSeconds) <= 1;
  return { ok, duration };
}
