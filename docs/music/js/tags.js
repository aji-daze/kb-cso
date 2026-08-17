// 音声ファイルからタグ（曲名・アーティスト・アルバム・ジャケット）を読む。
// MP3(ID3v2.2/2.3/2.4, ID3v1) / M4A・AAC(MP4 atom) / FLAC(Vorbis comment) に対応。
// 依存ライブラリなし・必要な範囲だけ file.slice() で読むので大きいファイルでも軽い。

const utf8 = new TextDecoder('utf-8');

function tryDecode(bytes, label) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ID3 の「ISO-8859-1」は日本語環境だと実際は UTF-8 か Shift_JIS のことが多い。
function decodeLoose(bytes) {
  if (!bytes.length) return '';
  if (!bytes.some((b) => b > 0x7f)) return new TextDecoder('iso-8859-1').decode(bytes);
  return (
    tryDecode(bytes, 'utf-8') ||
    tryDecode(bytes, 'shift_jis') ||
    new TextDecoder('iso-8859-1').decode(bytes)
  );
}

function decodeText(bytes, enc) {
  // enc: 0=ISO-8859-1, 1=UTF-16(BOM), 2=UTF-16BE, 3=UTF-8
  if (enc === 1) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
  if (enc === 3) return utf8.decode(bytes);
  return decodeLoose(bytes);
}

function trimNull(s) {
  return s.replace(/\0[\s\S]*$/, '').trim();
}

class Reader {
  constructor(file) {
    this.file = file;
  }
  async bytes(start, len) {
    if (start >= this.file.size) return new Uint8Array(0);
    const buf = await this.file.slice(start, Math.min(start + len, this.file.size)).arrayBuffer();
    return new Uint8Array(buf);
  }
}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function str(b, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

// ---------- ID3v2 ----------
async function readID3v2(reader, out) {
  const head = await reader.bytes(0, 10);
  if (head.length < 10 || str(head, 0, 3) !== 'ID3') return false;
  const major = head[3];
  const size = syncsafe(head, 6);
  const body = await reader.bytes(10, size);
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  let p = 0;
  while (p + headLen <= body.length) {
    const id = str(body, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // パディング領域に到達
    let fsize;
    if (major === 2) fsize = be24(body, p + 3);
    else if (major === 4) fsize = syncsafe(body, p + 4);
    else fsize = be32(body, p + 4);
    const start = p + headLen;
    if (fsize <= 0 || start + fsize > body.length) break;
    const data = body.subarray(start, start + fsize);
    applyID3Frame(id, data, out);
    p = start + fsize;
  }
  return true;
}

function applyID3Frame(id, data, out) {
  const textFrames = {
    TIT2: 'title', TT2: 'title',
    TPE1: 'artist', TP1: 'artist',
    TALB: 'album', TAL: 'album',
    TPE2: 'albumArtist', TP2: 'albumArtist',
    TRCK: 'trackNo', TRK: 'trackNo',
    TYER: 'year', TYE: 'year', TDRC: 'year',
    TCON: 'genre', TCO: 'genre',
  };
  const key = textFrames[id];
  if (key) {
    const v = trimNull(decodeText(data.subarray(1), data[0]));
    if (v && !out[key]) out[key] = v;
    return;
  }
  if ((id === 'APIC' || id === 'PIC') && !out.picture) {
    const enc = data[0];
    let p = 1;
    let mime;
    if (id === 'PIC') {
      mime = 'image/' + str(data, 1, 3).toLowerCase().replace('jpg', 'jpeg');
      p = 4;
    } else {
      let e = p;
      while (e < data.length && data[e] !== 0) e++;
      mime = decodeLoose(data.subarray(p, e)).toLowerCase() || 'image/jpeg';
      p = e + 1;
    }
    p += 1; // picture type
    // description（テキストエンコーディング依存の終端）
    if (enc === 1 || enc === 2) {
      while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < data.length && data[p] !== 0) p++;
      p += 1;
    }
    if (p < data.length) {
      if (!mime.startsWith('image/')) mime = 'image/jpeg';
      out.picture = new Blob([data.subarray(p)], { type: mime });
    }
  }
}

// ---------- ID3v1 ----------
async function readID3v1(reader, out) {
  if (reader.file.size < 128) return;
  const b = await reader.bytes(reader.file.size - 128, 128);
  if (str(b, 0, 3) !== 'TAG') return;
  const f = (o, n) => trimNull(decodeLoose(b.subarray(o, o + n)));
  if (!out.title) out.title = f(3, 30);
  if (!out.artist) out.artist = f(33, 30);
  if (!out.album) out.album = f(63, 30);
  if (!out.year) out.year = f(93, 4);
  if (!out.trackNo && b[125] === 0 && b[126] > 0) out.trackNo = String(b[126]);
}

// ---------- MP4 / M4A ----------
const MP4_KEYS = {
  '\xa9nam': 'title',
  '\xa9ART': 'artist',
  '\xa9alb': 'album',
  aART: 'albumArtist',
  '\xa9day': 'year',
  '\xa9gen': 'genre',
};

async function readMP4(reader, out) {
  const head = await reader.bytes(0, 12);
  if (head.length < 8 || str(head, 4, 4) !== 'ftyp') return false;

  // 直下の atom を辿って moov > udta > meta > ilst を探す
  const findChild = async (start, end, name, skip = 0) => {
    let p = start;
    while (p + 8 <= end) {
      const h = await reader.bytes(p, 8);
      if (h.length < 8) return null;
      let size = be32(h, 0);
      const type = str(h, 4, 4);
      if (size === 1) {
        const ext = await reader.bytes(p + 8, 8);
        size = be32(ext, 4); // 64bit の上位は無視（4GB 超の atom は想定外）
      }
      if (size < 8) return null;
      if (type === name) return { start: p + 8 + skip, end: Math.min(p + size, end) };
      p += size;
    }
    return null;
  };

  const moov = await findChild(0, reader.file.size, 'moov');
  if (!moov) return true;
  const udta = await findChild(moov.start, moov.end, 'udta');
  if (!udta) return true;
  const meta = await findChild(udta.start, udta.end, 'meta', 4); // meta は version/flags 4byte を持つ
  if (!meta) return true;
  const ilst = await findChild(meta.start, meta.end, 'ilst');
  if (!ilst) return true;

  const blob = await reader.bytes(ilst.start, ilst.end - ilst.start);
  let p = 0;
  while (p + 8 <= blob.length) {
    const size = be32(blob, p);
    if (size < 8 || p + size > blob.length) break;
    const type = str(blob, p + 4, 4);
    // 中の data atom
    let q = p + 8;
    while (q + 8 <= p + size) {
      const dsize = be32(blob, q);
      const dtype = str(blob, q + 4, 4);
      if (dsize < 8) break;
      if (dtype === 'data') {
        const flags = be32(blob, q + 8) & 0xffffff;
        const payload = blob.subarray(q + 16, q + dsize);
        const key = MP4_KEYS[type];
        if (key && !out[key]) out[key] = trimNull(utf8.decode(payload));
        else if (type === 'trkn' && payload.length >= 4 && !out.trackNo) out.trackNo = String((payload[2] << 8) | payload[3]);
        else if (type === 'covr' && !out.picture) {
          const mime = flags === 13 ? 'image/jpeg' : flags === 14 ? 'image/png' : 'image/jpeg';
          out.picture = new Blob([payload], { type: mime });
        }
      }
      q += dsize;
    }
    p += size;
  }
  return true;
}

// ---------- FLAC ----------
async function readFLAC(reader, out) {
  const head = await reader.bytes(0, 4);
  if (str(head, 0, 4) !== 'fLaC') return false;
  let p = 4;
  for (let i = 0; i < 64; i++) {
    const h = await reader.bytes(p, 4);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const size = be24(h, 1);
    const start = p + 4;
    if (type === 4) {
      const b = await reader.bytes(start, size);
      const vlen = le32(b, 0);
      let q = 4 + vlen;
      const count = le32(b, q);
      q += 4;
      for (let n = 0; n < count && q + 4 <= b.length; n++) {
        const len = le32(b, q);
        q += 4;
        const line = utf8.decode(b.subarray(q, q + len));
        q += len;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).toUpperCase();
        const v = line.slice(eq + 1).trim();
        if (!v) continue;
        if (k === 'TITLE' && !out.title) out.title = v;
        else if (k === 'ARTIST' && !out.artist) out.artist = v;
        else if (k === 'ALBUM' && !out.album) out.album = v;
        else if (k === 'ALBUMARTIST' && !out.albumArtist) out.albumArtist = v;
        else if (k === 'TRACKNUMBER' && !out.trackNo) out.trackNo = v;
        else if (k === 'DATE' && !out.year) out.year = v;
        else if (k === 'GENRE' && !out.genre) out.genre = v;
      }
    } else if (type === 6 && !out.picture) {
      const b = await reader.bytes(start, size);
      let q = 4;
      const mimeLen = be32(b, q);
      q += 4;
      const mime = str(b, q, mimeLen);
      q += mimeLen;
      const descLen = be32(b, q);
      q += 4 + descLen;
      q += 16; // width, height, depth, colors
      const dataLen = be32(b, q);
      q += 4;
      if (dataLen > 0 && q + dataLen <= b.length) out.picture = new Blob([b.subarray(q, q + dataLen)], { type: mime || 'image/jpeg' });
    }
    p = start + size;
    if (last) break;
  }
  return true;
}

// ---------- ファイル名からの推測 ----------
export function guessFromName(name) {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' ').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 3 && /^\d{1,3}$/.test(parts[0].trim())) {
    return { trackNo: parts[0].trim(), artist: parts[1].trim(), title: parts.slice(2).join(' - ').trim() };
  }
  if (parts.length === 2) {
    if (/^\d{1,3}$/.test(parts[0].trim())) return { trackNo: parts[0].trim(), title: parts[1].trim() };
    return { artist: parts[0].trim(), title: parts[1].trim() };
  }
  const m = base.match(/^(\d{1,3})[.\s]+(.+)$/);
  if (m) return { trackNo: m[1], title: m[2].trim() };
  return { title: base };
}

export async function readTags(file) {
  const out = {};
  const reader = new Reader(file);
  try {
    const isMp3 = await readID3v2(reader, out);
    if (!isMp3) {
      const isMp4 = await readMP4(reader, out);
      if (!isMp4) await readFLAC(reader, out);
    }
    if (!out.title || !out.artist) await readID3v1(reader, out);
  } catch (e) {
    console.warn('タグ読み取り失敗', file.name, e);
  }
  const guess = guessFromName(file.name);
  if (!out.title) out.title = guess.title || file.name;
  if (!out.artist && guess.artist) out.artist = guess.artist;
  if (!out.trackNo && guess.trackNo) out.trackNo = guess.trackNo;
  if (out.trackNo) out.trackNo = parseInt(String(out.trackNo).split('/')[0], 10) || 0;
  if (out.year) out.year = String(out.year).slice(0, 4);
  return out;
}

// 音声の長さは audio 要素に読ませるのが一番確実
export function readDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v) => {
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      clearTimeout(timer);
      done(isFinite(a.duration) ? a.duration : 0);
    };
    a.onerror = () => {
      clearTimeout(timer);
      done(0);
    };
    a.src = url;
  });
}
