package com.ajidaze.wataamemo;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * 入れ直さずに新しくする仕組み。
 *
 * 画面（index.html・sync.js）: GitHub Pages の最新を裏で取ってきて files/web/memo/ に置き、次からはそちらを返す。
 *   アプリを入れ直さなくても、画面の直しはこれで届く。中身を確かめてから置く（途中で切れた・別のページは使わない）。
 *   アプリ本体が新しくなったら（versionCode が変わったら）置いた物は捨て、同梱の画面に戻る。
 * アプリ本体: docs/apk/version.txt の番号が自分より新しければ、画面に「更新」を出す。
 *   押されたら APK を落として PackageInstaller に渡す（確認画面が出るので「更新」を押すだけ）。
 */
class Updater {

    static final String WEB = "https://aji-daze.github.io/kb-cso/memo/";
    static final String APK = "https://aji-daze.github.io/kb-cso/apk/wataamemo.apk";
    static final String VER = "https://aji-daze.github.io/kb-cso/apk/version.txt";
    static final String[] FILES = {"index.html", "sync.js"};
    static final String ACTION_INSTALLED = "com.ajidaze.wataamemo.INSTALL_STATUS";
    static final long EVERY = 30 * 60 * 1000L;

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("update", Context.MODE_PRIVATE); }

    static File dir(Context c) { return new File(c.getFilesDir(), "web/memo"); }

    // 取ってきた画面が今のアプリ本体で取った物なら使う
    static File override(Context c, String name) {
        if (prefs(c).getInt("webFor", -1) != BuildConfig.VERSION_CODE) return null;
        File f = new File(dir(c), name);
        return f.isFile() ? f : null;
    }

    static boolean due(Context c) { return System.currentTimeMillis() - prefs(c).getLong("last", 0) > EVERY; }

    /** 裏で確かめる。画面が新しくなったら true（呼んだ側が読み直す） */
    static boolean checkWeb(Context c) {
        prefs(c).edit().putLong("last", System.currentTimeMillis()).apply();
        try {
            byte[][] got = new byte[FILES.length][];
            boolean changed = false;
            for (int i = 0; i < FILES.length; i++) {
                got[i] = fetch(WEB + FILES[i] + "?t=" + System.currentTimeMillis());
                if (!looksRight(FILES[i], got[i])) return false;
                if (!Arrays.equals(got[i], current(c, FILES[i]))) changed = true;
            }
            if (!changed) return false;
            File d = dir(c);
            if (!d.isDirectory() && !d.mkdirs()) return false;
            for (int i = 0; i < FILES.length; i++) {
                File tmp = new File(d, FILES[i] + ".tmp");
                try (OutputStream o = new FileOutputStream(tmp)) { o.write(got[i]); }
            }
            for (String f : FILES) if (!new File(d, f + ".tmp").renameTo(new File(d, f))) return false;
            prefs(c).edit().putInt("webFor", BuildConfig.VERSION_CODE).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** アプリ本体の新しい版があるか */
    static boolean newerApk() {
        try {
            String v = new String(fetch(VER + "?t=" + System.currentTimeMillis()), StandardCharsets.UTF_8).trim();
            return Integer.parseInt(v) > BuildConfig.VERSION_CODE;
        } catch (Exception e) {
            return false;
        }
    }

    // 別のページ（Wi-Fi のログイン画面など）や途中で切れた物を置かない
    static boolean looksRight(String name, byte[] b) {
        String s = new String(b, StandardCharsets.UTF_8);
        if (name.equals("index.html")) return s.contains("<title>wataamemo</title>") && s.trim().endsWith("</html>");
        return s.contains("MemoSync") && s.trim().endsWith("})();");
    }

    static byte[] current(Context c, String name) throws IOException {
        File f = override(c, name);
        try (InputStream in = f != null ? new java.io.FileInputStream(f) : c.getAssets().open("memo/" + name)) { return read(in); }
    }

    static byte[] fetch(String u) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) { return read(in); }
        } finally {
            c.disconnect();
        }
    }

    static byte[] read(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int n;
        while ((n = in.read(b)) > 0) o.write(b, 0, n);
        return o.toByteArray();
    }

    /** APK を落として入れる（裏で呼ぶ）。うまくいかなければブラウザでダウンロードを開く */
    static void install(Activity a) {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            // 最初の1回だけ「このアプリからのインストールを許可」を聞く。戻ってきたらもう一度押してもらう
            a.runOnUiThread(() -> a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))));
            return;
        }
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        try {
            byte[] apk = fetch(APK + "?t=" + System.currentTimeMillis());
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(a.getPackageName());
            int id = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(id)) {
                try (OutputStream o = s.openWrite("wataamemo.apk", 0, apk.length)) {
                    o.write(apk);
                    s.fsync(o);
                }
                Intent back = new Intent(a, MainActivity.class).setAction(ACTION_INSTALLED);
                PendingIntent cb = PendingIntent.getActivity(a, 77, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                s.commit(cb.getIntentSender());
            }
        } catch (Exception e) {
            a.runOnUiThread(() -> {
                try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(APK))); } catch (Exception ignored) { }
            });
        }
    }
}
