// ジャケット画像をネットから探す。iTunes Search API を JSONP で叩く（CORS 不要・キー不要）。
// 見つかった画像は blob で保存するので、以後はオフラインでも表示できる。

function jsonp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cb = '__art_cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    };
    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('ジャケット検索に接続できませんでした'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('ジャケット検索がタイムアウトしました'));
    }, timeout);
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(script);
  });
}

function big(url, size = 600) {
  return url ? url.replace(/\/(\d+)x(\d+)([a-z\-]*)\.jpg$/, `/${size}x${size}bb.jpg`) : url;
}

export async function search(term, { limit = 12, country = 'jp' } = {}) {
  if (!navigator.onLine) throw new Error('オフラインです');
  const q = encodeURIComponent(term.trim());
  if (!q) return [];
  const url = `https://itunes.apple.com/search?term=${q}&entity=album&limit=${limit}&country=${country}`;
  let data;
  try {
    data = await jsonp(url);
  } catch (e) {
    // 日本のストアで出ない曲は US も見る
    data = await jsonp(`https://itunes.apple.com/search?term=${q}&entity=album&limit=${limit}&country=us`);
  }
  const seen = new Set();
  return (data.results || [])
    .filter((r) => r.artworkUrl100)
    .map((r) => ({
      artist: r.artistName,
      album: r.collectionName,
      year: (r.releaseDate || '').slice(0, 4),
      thumb: r.artworkUrl100,
      url: big(r.artworkUrl100),
    }))
    .filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
}

export async function fetchImage(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error('画像を取得できませんでした');
  const blob = await r.blob();
  if (!blob.type.startsWith('image/')) throw new Error('画像ではありませんでした');
  return blob;
}

// アルバム名＋アーティスト名で自動的に1件だけ拾う
export async function autoFind(album, artist) {
  const terms = [];
  if (album && artist) terms.push(`${artist} ${album}`);
  if (album) terms.push(album);
  if (!terms.length && artist) terms.push(artist);
  for (const t of terms) {
    try {
      const res = await search(t, { limit: 5 });
      if (res.length) return await fetchImage(res[0].url);
    } catch {}
  }
  return null;
}
