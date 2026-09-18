# テスト

Playwright で実機に近い形で動かす E2E テスト。一時ディレクトリに置くとセッションの
入れ替えで消えてしまうので、リポジトリの中に置いている。

    node docs/music/tests/e2e-resume.mjs      # 再生・自動再開・記録
    node docs/music/tests/e2e-tabs-start.mjs  # 起動時に開くタブ

各テストは自分で静的サーバ（serve.cjs）を立てて、終わったら止める。
`N passed, M failed` を出力し、失敗があれば終了コード 1。

- `mkmp3.mjs` … テスト用の MP3 を作る（ID3v2.3 タグ＋無音フレーム）
- `serve.cjs` … docs/music を静的配信する（PORT 環境変数、既定 8899）
