# 画面（JavaScript）から呼ぶメソッドは、名前を変えず消さない
-keepclassmembers class com.ajidaze.wataamemo.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
