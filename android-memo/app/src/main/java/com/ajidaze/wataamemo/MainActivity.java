package com.ajidaze.wataamemo;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * wataamemo の外殻。画面は docs/memo をアプリに同梱したものを WebView で開く。
 * ネットから画面を取らないので、電波がなくても・更新直後でも、いつも同じ版がすぐ開く。
 *
 * 軽さのために Android 標準の部品だけで書く（AndroidX・Kotlin を使わない）。
 * 画面は https://appassets.androidplatform.net/memo/ として、assets から自分で返す。
 * 本物の https のオリジンになるので、localStorage・crypto.subtle・GitHub への同期がそのまま動く。
 * メモはこのアプリの中（WebView の localStorage）に入る。ブラウザ版とは別の保存場所。
 */
public class MainActivity extends Activity {

    static final String HOST = "appassets.androidplatform.net";
    static final String URL = "https://" + HOST + "/memo/index.html";
    static final int REQ_FILE = 1, REQ_SAVE = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSave;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = night ? 0xFF0E0E0E : 0xFFFAFAF8;

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);   // 描き終わるまでテーマの地の色が見える（白く光らない）
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 30) {
            // 画面の端まで使い、ステータスバー・ナビゲーションバー・キーボードの分だけ内側に寄せる
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(night ? 0 : light, light);
            root.setOnApplyWindowInsetsListener((v, ins) -> {
                Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            // Android 8〜10: 端まで広げず、バーの色を地の色にそろえる（キーボードは adjustResize で避ける）
            w.setStatusBarColor(bg);
            w.setNavigationBarColor(bg);
            int f = 0;
            if (!night) f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(f);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.addJavascriptInterface(new Bridge(), "WataaApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;   // GitHub など外へはそのまま通す
                return asset(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (HOST.equals(req.getUrl().getHost())) return false;
                // トークンの作り方など、外のページはブラウザで開く
                try { startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl())); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(i, REQ_FILE); return true; }
                catch (Exception e) { fileCallback = null; return false; }
            }
        });

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(startUrl(getIntent()));
    }

    // assets/memo/... を返す
    private WebResourceResponse asset(String path) {
        if (path == null || path.contains("..")) return missing();
        String p = path.replaceFirst("^/+", "");
        try {
            InputStream in = getAssets().open(p);
            String mime = p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "application/javascript"
                    : p.endsWith(".json") ? "application/json" : p.endsWith(".png") ? "image/png" : "application/octet-stream";
            return new WebResourceResponse(mime, mime.startsWith("image") ? null : "utf-8", in);
        } catch (IOException e) {
            return missing();
        }
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
    }

    private String startUrl(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return URL;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT), title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if ((text == null || text.trim().isEmpty()) && (title == null || title.trim().isEmpty())) return URL;
        return URL + "?text=" + Uri.encode(text == null ? "" : text) + "&title=" + Uri.encode(title == null ? "" : title);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // 開いている最中に「共有」で呼ばれた: 画面を読み直す（書きかけは pagehide で保存される）
        if (Intent.ACTION_SEND.equals(intent.getAction())) web.loadUrl(startUrl(intent));
    }

    // 戻る: 一覧や同期の画面を閉じる。閉じるものがなければアプリを裏に回す（次に開くのが速い）
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.WataaBack?WataaBack():false", r -> { if (!"true".equals(r)) moveTaskToBack(true); });
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.MEMO&&MEMO.save()", null);   // 裏に回る前に必ず書き込む
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        Uri uri = res == RESULT_OK && data != null ? data.getData() : null;
        if (req == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(uri != null ? new Uri[]{uri} : null);
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            String text = pendingSave;
            pendingSave = null;
            if (uri == null || text == null) return;
            try (OutputStream o = getContentResolver().openOutputStream(uri)) {
                o.write(text.getBytes(StandardCharsets.UTF_8));
                toast("書き出しました");
            } catch (Exception e) {
                toast("書き出せませんでした");
            }
        }
    }

    private void toast(String msg) { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); }

    /** 画面 → アプリ。ブラウザの機能が WebView では使えないところを肩代わりする */
    public class Bridge {
        @JavascriptInterface
        public void share(String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                try { startActivity(Intent.createChooser(send, null)); } catch (Exception ignored) { }
            });
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("wataamemo", text));
                // Android 13 以降は OS がコピーを知らせるので、こちらからは出さない
                if (Build.VERSION.SDK_INT < 33) toast("コピーしました");
            });
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void saveFile(String name, String text) {
            runOnUiThread(() -> {
                pendingSave = text;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json").putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (Exception e) { pendingSave = null; toast("書き出せませんでした"); }
            });
        }

        @JavascriptInterface
        public String version() { return BuildConfig.VERSION_NAME; }
    }
}
