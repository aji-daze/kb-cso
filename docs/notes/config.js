// Azure に登録したアプリのクライアント ID。
// ここに書いておけば、どの端末でも設定画面で入力しなくて済む（秘密ではないので公開してよい）。
// 空のままなら、設定画面で端末ごとに入れる。
export const CLIENT_ID = '';

// 最初につなぐ OneDrive の場所。PC の「C:\Users\A.H\OneDrive」＝ OneDrive の一番上（'/'）。
// 一番上を指定すると、その中から Obsidian の保管庫（.obsidian があるフォルダ）を自動で探してつなぐ。
// 保管庫のフォルダが決まっているなら 'Documents/Obsidian/MyVault' のように書いてもよい。
// Windows のパス（C:\Users\A.H\OneDrive\…）をそのまま書いても読み替える。
export const VAULT = 'C:\\Users\\A.H\\OneDrive';
