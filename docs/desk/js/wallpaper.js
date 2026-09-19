// 背景。参考画像のような、うっすら波の入った無彩色の壁紙を既定にする。
// 自分の画像を使う場合は IndexedDB に入れる（localStorage では画像が入らないため）。

const Wallpaper = (() => {
  // 画像ファイルを持たずに済むよう、波は SVG で組み立てる
  function waves(a, b, c) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='1200' viewBox='0 0 1600 1200'>
      <defs>
        <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/>
        </linearGradient>
        <linearGradient id='w' x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stop-color='${c}' stop-opacity='.55'/>
          <stop offset='1' stop-color='${c}' stop-opacity='.05'/>
        </linearGradient>
      </defs>
      <rect width='1600' height='1200' fill='url(#g)'/>
      <path d='M0,470 C360,250 640,700 1010,430 C1270,240 1430,410 1600,320 L1600,1200 L0,1200 Z' fill='url(#w)'/>
      <path d='M0,650 C300,450 700,840 1050,620 C1310,455 1450,580 1600,510 L1600,1200 L0,1200 Z' fill='url(#w)' opacity='.55'/>
      <path d='M0,860 C320,700 680,1000 1080,830 C1320,730 1460,800 1600,760 L1600,1200 L0,1200 Z' fill='url(#w)' opacity='.35'/>
    </svg>`;
    return "url(\"data:image/svg+xml," + encodeURIComponent(svg.replace(/\s+/g, ' ')) + "\")";
  }

  const BUILT_IN = {
    waves: () => waves('#24252b', '#5b5e69', '#d8dae1'),
    slate: () => waves('#14202d', '#33506e', '#b6cde5'),
    ink: () => 'radial-gradient(120% 90% at 20% 0%, #23242a 0%, #0b0b0d 65%)',
    paper: () => waves('#dcdee4', '#f7f7f9', '#ffffff'),
  };

  // ---------- 自分の画像（IndexedDB） ----------
  const DB = 'desk-wall', STORE = 'img';
  let objectUrl = null;

  function db() {
    return new Promise((ok, ng) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ng(req.error);
    });
  }

  function put(blob) {
    return db().then((d) => new Promise((ok, ng) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, 'current');
      tx.oncomplete = ok;
      tx.onerror = () => ng(tx.error);
    }));
  }

  function get() {
    return db().then((d) => new Promise((ok) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get('current');
      req.onsuccess = () => ok(req.result || null);
      req.onerror = () => ok(null);
    })).catch(() => null);
  }

  function drop() {
    return db().then((d) => new Promise((ok) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = ok;
      tx.onerror = ok;
    })).catch(() => {});
  }

  function set(css) {
    document.documentElement.style.setProperty('--wall', css);
  }

  function apply() {
    const s = Store.get().settings;
    if (s.wallpaper === 'custom') {
      return get().then((blob) => {
        if (!blob) { set(BUILT_IN.waves()); return; }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        set(`url("${objectUrl}")`);
      });
    }
    const fn = BUILT_IN[s.wallpaper] || BUILT_IN.waves;
    set(fn());
    return Promise.resolve();
  }

  // 画像は端末の画面より大きい必要はない。長辺 2048px に縮めて持つ。
  function fromFile(file) {
    return new Promise((ok, ng) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 2048;
        const r = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * r);
        cv.height = Math.round(img.height * r);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob((blob) => (blob ? put(blob).then(ok, ng) : ng(new Error('変換できない'))), 'image/jpeg', 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ng(new Error('画像として読めない')); };
      img.src = url;
    });
  }

  return { apply, fromFile, drop, list: Object.keys(BUILT_IN) };
})();
