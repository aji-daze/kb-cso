plugins {
    id("com.android.application")
}

// 画面は docs/memo（Web 版と同じファイル）をそのまま同梱する。
// ネットから取らないので、更新直後に古い版で動く・電波がないと開けない、ということが起きない。
val memoAssets = layout.buildDirectory.dir("generated/memoAssets")
val copyMemo by tasks.registering(Sync::class) {
    from(rootProject.file("../docs/memo")) {
        include("index.html", "sync.js", "manifest.json", "icons/icon-192.png")
    }
    into(memoAssets.map { it.dir("memo") })
}

android {
    namespace = "com.ajidaze.wataamemo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ajidaze.wataamemo"
        minSdk = 26
        targetSdk = 35
        // 上書きで入れ直せるよう、ビルドごとに番号を増やす（GitHub Actions の実行番号）
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // 署名鍵は固定（リポジトリに置いてある）。ビルドのたびに鍵が変わると上書きで入れ直せず、
    // 一度消すと端末のメモも消えてしまうため。個人で直接入れる用で、ストアには出さない。
    signingConfigs {
        create("fixed") {
            storeFile = file("wataamemo.keystore")
            storePassword = "wataamemo"
            keyAlias = "wataamemo"
            keyPassword = "wataamemo"
        }
    }

    buildTypes {
        release {
            // 使っていないコードと資源を削って小さくする
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("fixed")
        }
        debug {
            signingConfig = signingConfigs.getByName("fixed")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(memoAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") { dependsOn(copyMemo) }
