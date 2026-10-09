# wataamemo for Android

wataamemo（`../docs/memo/`）をそのまま同梱した Android アプリ。ブラウザの「ホーム画面に追加」が
うまくいかない端末向けの、もう一つの入れ方。

## 入れ方（スマホだけで）

1. スマホのブラウザで次を開く（ダウンロードが始まる）
   `https://github.com/aji-daze/kb-cso/releases/download/wataamemo/wataamemo.apk`
2. ダウンロードした `wataamemo.apk` を開く
3. 「提供元不明のアプリ」を聞かれたら、そのブラウザ（またはファイルアプリ）に許可して、もう一度開く
4. 「インストール」

更新するときも同じリンクから落として、上から入れるだけ（消さなくてよい）。

## Web 版との違い

| | Web 版（ホーム画面に追加） | このアプリ |
| --- | --- | --- |
| 画面の取得 | ネットから。更新直後の1回目は古い版のことがある | アプリに同梱。いつも同じ版がすぐ開く |
| 電波がないとき | 一度開いていれば開く | 開く |
| 「共有」から | Chrome で入れたときだけ | できる |
| 書き出し | ブラウザのダウンロード | 保存先を選ぶ画面 |
| メモの保存場所 | ブラウザの中 | このアプリの中（別々） |

ブラウザ版のメモは自動では移らない。同期（GitHub）をつなげば、同じ置き場所から取り込まれる。
つながない場合は、ブラウザ版で「書き出し」→ アプリで「読み込み」。

## 仕組み

- 画面は `https://appassets.androidplatform.net/assets/memo/` として WebView で開く（`WebViewAssetLoader`）。
  本物の https のオリジンなので、localStorage・crypto.subtle・GitHub への同期がブラウザと同じに動く
- ブラウザの機能が WebView で使えないところ（共有・コピー・書き出し・ファイル選択・戻る）は、
  画面から `window.WataaApp` を呼んでアプリ側がやる
- ビルド時に `docs/memo` の `index.html`・`sync.js`・`manifest.json`・`icons/` を assets に写す

## ビルド

GitHub Actions（`.github/workflows/wataamemo-apk.yml`）が作る。

- どのブランチでも、`android-memo/**` か `docs/memo/**` を変えて push → Actions の成果物（wataamemo-apk）
- main に入ったら、Releases の `wataamemo` の APK を差し替える（上のリンクはずっと同じ）

署名鍵は `app/wataamemo.keystore`（パスワードは `app/build.gradle.kts` に書いてある）。
ビルドのたびに鍵が変わると上から入れ直せず、消すと端末のメモも消えてしまうので、固定してリポジトリに置いている。
公開リポジトリなので鍵は誰でも見られる。個人で直接入れる用で、ストアには出さない。

手元でビルドするなら Android SDK（compileSdk 35）と JDK 17 で `./gradlew assembleRelease`。
