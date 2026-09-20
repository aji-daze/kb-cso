// zip の読み取り。EPUB と青空文庫の索引の両方で使う。
// 展開はブラウザ標準の DecompressionStream('deflate-raw') に任せるので、ライブラリは要らない。

const S_EOCD = 0x06054b50;
const S_EOCD64 = 0x06064b50;
const S_CEN = 0x02014b50;

function findEOCD(dv) {
  const max = Math.min(dv.byteLength, 66000);
  for (let i = dv.byteLength - 22; i >= dv.byteLength - max; i--) {
    if (i < 0) break;
    if (dv.getUint32(i, true) === S_EOCD) return i;
  }
  return -1;
}

export async function readZip(blob) {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  const eocd = findEOCD(dv);
  if (eocd < 0) throw new Error('zip として読めません');

  let count = dv.getUint16(eocd + 10, true);
  let cenOff = dv.getUint32(eocd + 16, true);

  // zip64（4GB 超・65535 件超）。索引ファイルが将来大きくなっても落ちないように見る。
  if (cenOff === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(i + 8, true));
        if (dv.getUint32(z64, true) === S_EOCD64) {
          count = Number(dv.getBigUint64(z64 + 32, true));
          cenOff = Number(dv.getBigUint64(z64 + 48, true));
        }
        break;
      }
    }
  }

  const dec = new TextDecoder('utf-8');
  const entries = new Map();
  let p = cenOff;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== S_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
    entries.set(name, { name, method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }

  async function raw(e) {
    // ローカルヘッダを読み直してデータの開始位置を出す（中央ディレクトリの値とずれることがある）
    const nlen = dv.getUint16(e.lho + 26, true);
    const elen = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nlen + elen;
    const slice = buf.slice(start, start + e.csize);
    if (e.method === 0) return new Uint8Array(slice);
    if (e.method !== 8) throw new Error('未対応の圧縮方式: ' + e.method);
    const ds = new DecompressionStream('deflate-raw');
    const out = new Blob([slice]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    bytes: async (n) => { const e = entries.get(n); if (!e) throw new Error('見つかりません: ' + n); return raw(e); },
    text: async (n, enc) => new TextDecoder(enc || 'utf-8').decode(await (async () => {
      const e = entries.get(n); if (!e) throw new Error('見つかりません: ' + n); return raw(e);
    })()),
  };
}

export function supported() {
  return typeof DecompressionStream === 'function';
}
