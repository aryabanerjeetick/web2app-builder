package com.web2app.container

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import java.nio.charset.StandardCharsets

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null
    private var pendingGeoOrigin: String? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingWebResources: Array<String> = emptyArray()
    private var pendingAndroidPermissions: Array<String> = emptyArray()
    private var pendingDownload: DownloadDetails? = null

    private val startUrl: String by lazy {
        String(Base64.decode(BuildConfig.START_URL_BASE64, Base64.NO_WRAP), StandardCharsets.UTF_8)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(22, 21, 45)
        window.navigationBarColor = Color.WHITE
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        webView = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = true
            settings.setSupportMultipleWindows(false)
            settings.mediaPlaybackRequiresUserGesture = true
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        }

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = android.content.res.ColorStateList.valueOf(Color.rgb(103, 87, 232))
            progressBackgroundTintList = android.content.res.ColorStateList.valueOf(Color.TRANSPARENT)
        }
        errorPanel = createErrorPanel()

        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(progressBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP))
        root.addView(errorPanel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return when (uri.scheme?.lowercase()) {
                    "https", "http" -> false
                    "mailto", "tel", "sms" -> openExternal(uri)
                    else -> true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                errorPanel.visibility = View.GONE
                progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progressBar.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                if (request.isForMainFrame) {
                    progressBar.visibility = View.GONE
                    errorPanel.visibility = View.VISIBLE
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(params.createIntent(), REQUEST_FILE_PICKER)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val hasLocation = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                if (hasLocation) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    requestPermissions(
                        arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION),
                        REQUEST_LOCATION,
                    )
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermissionRequest(request) }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingWebPermission === request) {
                    pendingWebPermission = null
                    pendingWebResources = emptyArray()
                    pendingAndroidPermissions = emptyArray()
                }
            }

            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle(view.title ?: getString(R.string.app_name))
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle(view.title ?: getString(R.string.app_name))
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            override fun onJsPrompt(
                view: WebView,
                url: String,
                message: String,
                defaultValue: String,
                result: JsPromptResult,
            ): Boolean {
                val input = android.widget.EditText(this@MainActivity).apply { setText(defaultValue) }
                AlertDialog.Builder(this@MainActivity)
                    .setTitle(view.title ?: getString(R.string.app_name))
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(input.text.toString()) }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            downloadFile(url, userAgent, contentDisposition, mimeType)
        }

        val postUrl = notificationPostUrl(intent)
        if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null && postUrl == null) {
            // Keep the page and navigation stack after a configuration change.
        } else {
            webView.loadUrl(postUrl ?: startUrl)
        }
        if (BuildConfig.POST_NOTIFICATIONS_ENABLED) {
            FeedNotificationWorker.schedule(this)
            requestPostNotificationsIfNeeded()
        }
    }

    private fun notificationPostUrl(source: Intent?): String? {
        val value = source?.getStringExtra(EXTRA_POST_URL) ?: return null
        val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return null
        return value.takeIf { uri.scheme == "https" && !uri.host.isNullOrBlank() }
    }

    private fun requestPostNotificationsIfNeeded() {
        if (android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) return
        val preferences = getSharedPreferences("post_notifications", MODE_PRIVATE)
        if (preferences.getBoolean("permission_prompted", false)) return
        preferences.edit().putBoolean("permission_prompted", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        notificationPostUrl(intent)?.let { webView.loadUrl(it) }
    }

    private fun createErrorPanel(): LinearLayout {
        val title = TextView(this).apply {
            text = "Can't load this page"
            textSize = 20f
            setTextColor(Color.rgb(31, 34, 49))
            gravity = Gravity.CENTER
        }
        val detail = TextView(this).apply {
            text = "Check your internet connection, then try again."
            textSize = 15f
            setTextColor(Color.rgb(103, 106, 125))
            gravity = Gravity.CENTER
        }
        val retry = Button(this).apply {
            text = "Try again"
            setOnClickListener {
                errorPanel.visibility = View.GONE
                webView.reload()
            }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(24), dp(32), dp(24))
            setBackgroundColor(Color.WHITE)
            addView(title)
            addView(detail, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(10)
            })
            addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(16)
            })
            visibility = View.GONE
        }
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        val mainOrigin = runCatching { Uri.parse(webView.url).host }.getOrNull()
        val requestOrigin = runCatching { Uri.parse(request.origin.toString()).host }.getOrNull()
        if (mainOrigin.isNullOrBlank() || mainOrigin != requestOrigin || request.origin.scheme != "https") {
            request.deny()
            return
        }

        val androidPermissions = mutableListOf<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> androidPermissions.add(Manifest.permission.CAMERA)
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> androidPermissions.add(Manifest.permission.RECORD_AUDIO)
                else -> {
                    request.deny()
                    return
                }
            }
        }
        if (androidPermissions.isEmpty()) {
            request.deny()
            return
        }

        val missing = androidPermissions.distinct().filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            request.grant(request.resources)
        } else {
            pendingWebPermission = request
            pendingWebResources = request.resources
            pendingAndroidPermissions = missing.toTypedArray()
            requestPermissions(pendingAndroidPermissions, REQUEST_WEB_PERMISSION)
        }
    }

    private fun downloadFile(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        val uri = runCatching { Uri.parse(url) }.getOrNull()
        if (uri == null || uri.scheme !in listOf("http", "https")) {
            Toast.makeText(this, "This download link is not supported.", Toast.LENGTH_LONG).show()
            return
        }
        val details = DownloadDetails(url, userAgent, contentDisposition, mimeType)
        if (android.os.Build.VERSION.SDK_INT <= android.os.Build.VERSION_CODES.P &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingDownload = details
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_STORAGE)
            return
        }
        enqueueDownload(details)
    }

    private fun enqueueDownload(details: DownloadDetails) {
        val (url, userAgent, contentDisposition, mimeType) = details
        val uri = Uri.parse(url)
        try {
            val request = DownloadManager.Request(uri)
                .setTitle(android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType))
                .setDescription("Downloading from ${uri.host ?: "website"}")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS,
                    android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                )
                .addRequestHeader("User-Agent", userAgent)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            Toast.makeText(this, "Download started. Check your Downloads folder.", Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, "Couldn't start this download. Try opening it in your browser.", Toast.LENGTH_LONG).show()
        }
    }

    private fun openExternal(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (_: Exception) {
            Toast.makeText(this, "No app is available to open this link.", Toast.LENGTH_SHORT).show()
            true
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Android, retained for WebView file picker compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_PICKER) {
            val callback = fileChooserCallback ?: return
            val result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            callback.onReceiveValue(result)
            fileChooserCallback = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQUEST_LOCATION -> {
                val granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                pendingGeoCallback?.invoke(pendingGeoOrigin ?: "", granted, false)
                pendingGeoCallback = null
                pendingGeoOrigin = null
            }
            REQUEST_WEB_PERMISSION -> {
                val request = pendingWebPermission
                val required = pendingAndroidPermissions
                val granted = request != null && required.all {
                    checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
                }
                if (granted) request?.grant(pendingWebResources) else request?.deny()
                pendingWebPermission = null
                pendingWebResources = emptyArray()
                pendingAndroidPermissions = emptyArray()
            }
            REQUEST_STORAGE -> {
                val details = pendingDownload
                pendingDownload = null
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED && details != null) {
                    enqueueDownload(details)
                } else {
                    Toast.makeText(this, "Allow file access to save this download.", Toast.LENGTH_LONG).show()
                }
            }
            REQUEST_POST_NOTIFICATIONS -> {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                    Toast.makeText(this, "New post notifications are enabled.", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQUEST_FILE_PICKER = 501
        private const val REQUEST_LOCATION = 502
        private const val REQUEST_WEB_PERMISSION = 503
        private const val REQUEST_STORAGE = 504
        private const val REQUEST_POST_NOTIFICATIONS = 505
        const val EXTRA_POST_URL = "com.web2app.container.POST_URL"
    }

    private data class DownloadDetails(
        val url: String,
        val userAgent: String,
        val contentDisposition: String?,
        val mimeType: String?,
    )
}
