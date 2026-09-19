# DESK for Android（ホーム画面ウィジェット付き）

Android のホーム画面ウィジェットはネイティブアプリでしか作れないため、
Web 版 DESK を包む薄い APK を用意した。中身は次の2つだけ。

1. **WebView の外殻** — DESK（`/kb-cso/desk/`）と ConTodo（`/chakushu/`）を1つの WebView で開く。
   この2つは同じオリジンなので、アプリの中で localStorage を共有する。
2. **ウィジェット3種**（Glance 製、半透明）
   - 今日の流れ：いまの予定・次の予定・残り時間
   - やること：残タスクと「次の一歩」
   - 集中：今日の分数、連続日数、終業まで

## データの流れ

```
DESK の画面 (JS)
  └─ window.DeskAndroid.publish(json)   ← 表示を書き換えるたびに送る
       └─ DataStore に保存
            └─ ウィジェットを再描画（変更時／15分ごと／30分ごとのシステム更新）
```

ウィジェットは端末の時計を見て「いま」を自分で計算するので、
アプリを開いていない間も現在の予定表示はずれない。

## 注意：保存場所は WebView とブラウザで別

Chrome で使っていた DESK / ConTodo のデータは、この APK の WebView には入っていない。
移すときは一度だけ、Chrome 側で「書き出し」→ アプリ側で「読み込み」をする
（ConTodo は設定の「バックアップを書き出す」、DESK は設定 ≡ の「書き出し」）。
以後はアプリの中だけで使えば、ウィジェットまで一貫する。

## ビルドと導入

GitHub Actions（`.github/workflows/android.yml`）が APK を作る。

- 任意のブランチに `android/**` を push → Actions の成果物（desk-apk）から取得
- タグ `android-v1.0` を push → Releases に APK が付く

```
git tag android-v1.0 && git push origin android-v1.0
```

APK は **debug 署名**。Play ストアには出せないが、端末に直接入れて使うぶんには問題ない。
端末側で「提供元不明のアプリ」（設定 → アプリ → 特別なアプリアクセス → 不明なアプリのインストール）を
そのブラウザ／ファイルアプリに許可してから開く。

リリース鍵で署名したい場合は `app/build.gradle.kts` の `signingConfig` を差し替え、
キーストアを GitHub Secrets に置いてワークフローで復元する。

## 手元でビルドする場合

```
cd android
./gradlew assembleRelease      # app/build/outputs/apk/release/app-release.apk
```

Android SDK（compileSdk 35）と JDK 17 が要る。
