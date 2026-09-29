// Azure に登録したアプリのクライアント ID。
// ここに書いておけば、どの端末でも設定画面で入力しなくて済む（秘密ではないので公開してよい）。
// 空のままなら、設定画面で端末ごとに入れる。
export const CLIENT_ID = '';

// Obsidian の保管庫の場所。Windows のパスのまま書いてよい（OneDrive 上のパス 'Obsidian' に読み替える）。
//  ・OneDrive につなぐとき：OneDrive の中のこのフォルダを開く
//  ・PC のフォルダを直接開くとき：OneDrive フォルダそのものを選んでも、中のこのフォルダを使う
// OneDrive の一番上（C:\Users\A.H\OneDrive）を書くと、中から .obsidian のあるフォルダを自動で探す。
export const VAULT = 'C:\\Users\\A.H\\OneDrive\\Obsidian';
