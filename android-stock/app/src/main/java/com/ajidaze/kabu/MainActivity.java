package com.ajidaze.kabu;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 株ダッシュの公開ページを開くだけのアプリ。
 * PIN とトークンは WebView の localStorage に入る。Chrome とも他の自作アプリとも別の保存場所で、
 * ここで動くのは株ダッシュの1ページだけなので、同じ github.io の他のページからは読めない。
 */
public class MainActivity extends Activity {
    private static final String HOST = "aji-daze.github.io";
    private static final String HOME = "https://" + HOST + "/kb-cso/";
    private static final int BG = 0xFF0F172A;
    private static final String OFFLINE =
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<body style='background:#0f172a;color:#e6e9ef;font-family:sans-serif;text-align:center;padding-top:40vh'>"
            + "<p>読み込めませんでした</p><p><a style='color:#5b9dff' href='" + HOME + "'>もう一度</a></p>";

    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        // targetSdk 35 では画面の端まで描かれるので、システムバーの分だけ内側に寄せる
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });

        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        // 既定の WebChromeClient を置かないと alert / prompt が出ない（⚡のトークン入力に使う）
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isHome(u)) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                view.loadDataWithBaseURL(null, OFFLINE, "text/html", "utf-8", null);
            }
        });

        root.addView(web);
        setContentView(root);
        root.requestApplyInsets();

        if (saved == null) web.loadUrl(HOME);
        else web.restoreState(saved);
    }

    private static boolean isHome(Uri u) {
        if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return false;
        String p = u.getPath();
        return "/kb-cso/".equals(p) || "/kb-cso/index.html".equals(p);
    }

    /** 株ダッシュ以外のページはこのアプリの中で動かさない */
    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
