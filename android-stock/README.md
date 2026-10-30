# 株ダッシュ for Android

公開ページ（`../docs/index.html`）を WebView で開くだけのアプリ。画面はネットから読むので、
画面やデータを直しても APK を作り直す必要はない。

- 入れ方: スマホの Chrome で `https://aji-daze.github.io/kb-cso/apk/kabu.apk` を開く → ダウンロードした APK を開く → 「提供元不明のアプリ」を許可 → インストール。更新も同じ手順で上から入れる。
- PIN とトークンはこのアプリの WebView の中に保存する。Chrome 版とは別なので、初回に入れ直す。
- 株ダッシュ以外のページはアプリの中で開かず、外のブラウザに渡す。同じ github.io の他のページに PIN とトークンを読ませないため。

## ビルド

GitHub Actions（`.github/workflows/kabu-apk.yml`）が作る。どのブランチでも Actions の成果物に残り、
main に入ると `docs/apk/kabu.apk` を差し替える。署名は wataamemo と同じ Secrets を使う。
