// Torchless for Android: a Trusted Web Activity. The app opens the Torchless
// web app (GitHub Pages, custom domain torchless.brickandsignal.com) full screen in Chrome, which has Web Bluetooth.
// All rig logic lives in the web app; this shell has none.

plugins {
    id("com.android.application")
}

val siteHost = "torchless.brickandsignal.com"
val startUrl = "https://$siteHost/"

android {
    namespace = "com.brickandsignal.torchless"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.brickandsignal.torchless"
        minSdk = 24
        targetSdk = 36
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = "0.1.1"
        manifestPlaceholders["hostName"] = siteHost
        manifestPlaceholders["launchUrl"] = startUrl
        resValue("string", "asset_statements",
            "[{\\\"relation\\\": [\\\"delegate_permission/common.handle_all_urls\\\"], " +
            "\\\"target\\\": {\\\"namespace\\\": \\\"web\\\", \\\"site\\\": \\\"https://$siteHost\\\"}}]")
    }

    signingConfigs {
        create("upload") {
            val ks = System.getenv("UPLOAD_KEYSTORE_PATH")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (System.getenv("UPLOAD_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("upload")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { resValues = true }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
