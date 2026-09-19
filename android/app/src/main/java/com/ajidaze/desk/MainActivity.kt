package com.ajidaze.desk

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * DESK と ConTodo を同じ WebView で開くだけの外殻。
 * 2つは同じオリジン（aji-daze.github.io）なので、この中で localStorage を共有する。
 * 画面側は window.DeskAndroid.publish(json) でその日の要約を渡してくる。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.addJavascriptInterface(WebBridge(), "DeskAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val host = req.url.host ?: return false
                // 自分たちのページ以外はブラウザに渡す
                if (host == HOST) return false
                startActivity(Intent(Intent.ACTION_VIEW, req.url))
                return true
            }
        }

        findViewById<Button>(R.id.tabDesk).setOnClickListener { load(URL_DESK) }
        findViewById<Button>(R.id.tabFocus).setOnClickListener { load(URL_CONTODO) }
        findViewById<View>(R.id.tabReload).setOnClickListener { web.reload() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        if (savedInstanceState == null) load(URL_DESK)

        // ウィジェットの「いま」を進めるための定期更新
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "desk-widget-refresh",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).build(),
        )
    }

    private fun load(url: String) {
        web.loadUrl(url)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        web.restoreState(savedInstanceState)
    }

    /** 画面 → アプリ。受け取った要約を保存し、ウィジェットを描き直す。 */
    inner class WebBridge {
        @JavascriptInterface
        fun publish(json: String) {
            lifecycleScope.launch {
                SnapshotStore.save(applicationContext, json)
                RefreshWorker.updateWidgets(applicationContext)
            }
        }

        /** 画面側から「Android 版か」を判定できるように */
        @JavascriptInterface
        fun version(): String = "${BuildConfig.VERSION_NAME} (API ${Build.VERSION.SDK_INT})"
    }

    companion object {
        const val HOST = "aji-daze.github.io"
        const val URL_DESK = "https://aji-daze.github.io/kb-cso/desk/"
        const val URL_CONTODO = "https://aji-daze.github.io/chakushu/"

        fun openUri(): Uri = Uri.parse(URL_DESK)
    }
}
