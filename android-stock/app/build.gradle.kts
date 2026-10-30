plugins {
    id("com.android.application")
}

android {
    namespace = "com.ajidaze.kabu"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ajidaze.kabu"
        minSdk = 26
        targetSdk = 35
        // 上書きで入れ直せるよう、ビルドごとに番号を増やす（GitHub Actions の実行番号）
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // 署名鍵は wataamemo と同じものを GitHub Secrets から復元する。個人で直接入れる用。
    signingConfigs {
        create("fixed") {
            storeFile = file("signing.p12")
            storeType = "pkcs12"
            storePassword = System.getenv("SIGNING_PASSWORD")
            keyAlias = "wataamemo"
            keyPassword = System.getenv("SIGNING_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.getByName("fixed")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
