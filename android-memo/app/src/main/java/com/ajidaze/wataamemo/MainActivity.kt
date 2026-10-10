package com.ajidaze.wataamemo

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader

/**
 * wataamemo の外殻。画面は docs/memo をアプリに同梱したものを WebView で開く。
 * ネットから画面を取らないので、電波がなくても・更新直後でも、いつも同じ版がすぐ開く。
 *
 * 画面は https://appassets.androidplatform.net/assets/memo/ として読む（WebViewAssetLoader）。
 * 本物の https のオリジンになるので、localStorage・crypto.subtle・GitHub への同期がそのまま動く。
 * メモはこのアプリの中（WebView の localStorage）に入る。ブラウザ版とは別の保存場所。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: String? = null

    // 「読み込み」のファイル選択
    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCallback = null
    }

    // 「書き出し」の保存先選択
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val text = pendingSave
        pendingSave = null
        if (uri == null || text == null) return@registerForActivityResult
        runCatching { contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) } }
            .onSuccess { toast("書き出しました") }
            .onFailure { toast("書き出せませんでした") }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 画面の端まで使い、ステータスバー・ナビゲーションバー・キーボードの分だけ内側に寄せる
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        val root = FrameLayout(this)
        web = WebView(this)
        web.setBackgroundColor(Color.TRANSPARENT)   // 描き終わるまでテーマの地の色が見える（白く光らない）
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        web.addJavascriptInterface(Bridge(), "WataaApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                // トークンの作り方など、外のページはブラウザで開く
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return runCatching { pickFile.launch("*/*") }.isSuccess.also { if (!it) fileCallback = null }
            }
        }

        // 戻る: 一覧や同期の画面を閉じる。閉じるものがなければアプリを裏に回す（次に開くのが速い）
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.WataaBack?WataaBack():false") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        if (web.url == null) web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 開いている最中に「共有」で呼ばれた: 画面を読み直す（書きかけは pagehide で保存される）
        if (intent.action == Intent.ACTION_SEND) web.loadUrl(startUrl(intent))
    }

    override fun onPause() {
        // 裏に回る前に必ず書き込む
        web.evaluateJavascript("window.MEMO&&MEMO.save()", null)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun startUrl(intent: Intent?): String {
        if (intent?.action != Intent.ACTION_SEND) return URL
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        if (text.isBlank() && title.isBlank()) return URL
        return URL + "?text=" + Uri.encode(text) + "&title=" + Uri.encode(title)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    /** 画面 → アプリ。ブラウザの機能が WebView では使えないところを肩代わりする */
    inner class Bridge {
        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            runCatching { startActivity(Intent.createChooser(send, null)) }
        }

        @JavascriptInterface
        fun copy(text: String) = runOnUiThread {
            val cm = getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText("wataamemo", text))
            // Android 13 以降は OS がコピーを知らせるので、こちらからは出さない
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) toast("コピーしました")
        }

        @JavascriptInterface
        fun saveFile(name: String, text: String) = runOnUiThread {
            pendingSave = text
            runCatching { createDoc.launch(name) }.onFailure { pendingSave = null; toast("書き出せませんでした") }
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val URL = "https://$HOST/assets/memo/index.html"
    }
}
