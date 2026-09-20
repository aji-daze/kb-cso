"""青空文庫の目録を作って docs/read/data/ に置く。

ブラウザから青空文庫を直接読むことはできない（CORS を許可していない）。
そこで GitHub Actions のなかで取ってきて、自分の GitHub Pages に置く。
アプリは同一オリジンから読むだけになるので、CORS の問題が消える。

本文は入れない。目録（作品名・著者・ダウンロード先の URL）だけ。
"""
import csv, gzip, io, json, os, re, time, urllib.parse, urllib.request, zipfile

UA = "pocha-bunko-index/1.0 (+https://github.com/aji-daze/kb-cso)"
OUT = "docs/read/data/aozora-index.json.gz"

# 置き場所が変わっていても拾えるように、候補を試してから最後に索引ページを見に行く
CANDIDATES = [
    "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip",
    "https://www.aozora.gr.jp/index_pages/list_person_all_utf8.zip",
]
LOOKUP_PAGES = [
    "https://www.aozora.gr.jp/index_pages/person_all.html",
    "https://www.aozora.gr.jp/",
]


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def find_zip():
    for u in CANDIDATES:
        try:
            data = get(u)
            print(f"  取得できた: {u}（{len(data):,} バイト）")
            return data
        except Exception as e:
            print(f"  だめ: {u} → {e}")
    # 候補が全部だめなら、ページの中からリンクを探す
    for page in LOOKUP_PAGES:
        try:
            html = get(page, timeout=60).decode("utf-8", "replace")
        except Exception as e:
            print(f"  ページも読めない: {page} → {e}")
            continue
        for m in re.finditer(r'href="([^"]*list_person_all[^"]*\.zip)"', html):
            u = urllib.parse.urljoin(page, m.group(1))
            try:
                data = get(u)
                print(f"  ページから見つけた: {u}（{len(data):,} バイト）")
                return data
            except Exception as e:
                print(f"  だめ: {u} → {e}")
    raise SystemExit("目録の zip が見つかりませんでした。青空文庫側の置き場所が変わった可能性があります。")


def main():
    print("青空文庫の目録を取りに行きます")
    blob = find_zip()

    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next((n for n in z.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise SystemExit("zip の中に CSV がありません")
        raw = z.read(name)

    text = raw.decode("utf-8-sig", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    head = rows.pop(0)
    print(f"  CSV: {name} / {len(rows):,} 行 / 列 {len(head)}")

    def col(*names):
        for n in names:
            if n in head:
                return head.index(n)
        return -1

    i_id = col("作品ID")
    i_title = col("作品名")
    i_kana = col("作品名読み")
    i_sei = col("姓")
    i_mei = col("名")
    i_free = col("作品著作権フラグ")
    i_txt = col("テキストファイルURL")
    i_html = next((i for i, h in enumerate(head) if "XHTML/HTML" in h), -1)
    if i_title < 0 or (i_txt < 0 and i_html < 0):
        raise SystemExit(f"CSV の列が想定と違います: {head[:20]}")

    seen = set()
    out = []
    for r in rows:
        if len(r) <= i_title or not r[i_title]:
            continue
        if i_free >= 0 and r[i_free] != "なし":      # 著作権が切れているものだけ
            continue
        txt = r[i_txt] if i_txt >= 0 and len(r) > i_txt else ""
        htm = r[i_html] if i_html >= 0 and len(r) > i_html else ""
        if not txt and not htm:
            continue
        wid = r[i_id] if i_id >= 0 and len(r) > i_id else ""
        author = ((r[i_sei] if i_sei >= 0 and len(r) > i_sei else "") +
                  (r[i_mei] if i_mei >= 0 and len(r) > i_mei else "")).strip()
        key = (wid, author)
        if key in seen:
            continue
        seen.add(key)
        out.append([
            wid, r[i_title],
            (r[i_kana] if i_kana >= 0 and len(r) > i_kana else ""),
            author, txt, htm,
        ])

    out.sort(key=lambda x: (x[3], x[1]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = json.dumps({"at": int(time.time()), "n": len(out), "rows": out}, ensure_ascii=False, separators=(",", ":"))
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(body.encode("utf-8"))
    print(f"  書き出し: {OUT} / {len(out):,} 作品 / {os.path.getsize(OUT):,} バイト")


if __name__ == "__main__":
    main()
