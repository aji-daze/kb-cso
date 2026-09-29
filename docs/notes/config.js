// Azure に登録したアプリのクライアント ID。
// ここに書いておけば、どの端末でも設定画面で入力しなくて済む（秘密ではないので公開してよい）。
// 空のままなら、設定画面で端末ごとに入れる。
export const CLIENT_ID = '';

// Obsidian の保管庫の場所。Windows のパスのまま書いてよい（OneDrive 上のパス 'Obsidian' に読み替える）。
//  ・OneDrive につなぐとき：OneDrive の中のこのフォルダを開く
//  ・PC のフォルダを直接開くとき：OneDrive フォルダそのものを選んでも、中のこのフォルダを使う
// OneDrive の一番上（C:\Users\A.H\OneDrive）を書くと、中から .obsidian のあるフォルダを自動で探す。
export const VAULT = 'C:\\Users\\A.H\\OneDrive\\Obsidian';

// GitHub につなぐとき（pomenote と同じ非公開リポジトリ）。トークンは秘密なのでここには書かず、各端末の設定画面で入れる。
// root：リポジトリの中の保管庫の場所（リポジトリの一番上 ＝ OneDrive の一番上）。
export const GITHUB = { owner: 'aji-daze', repo: 'pomera-data', branch: 'main', root: 'Obsidian' };
