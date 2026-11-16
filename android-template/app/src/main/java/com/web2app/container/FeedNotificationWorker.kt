package com.web2app.container

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.util.Xml
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

class FeedNotificationWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (!BuildConfig.POST_NOTIFICATIONS_ENABLED) return Result.success()
        val feedUrl = runCatching {
            String(Base64.decode(BuildConfig.POSTS_FEED_BASE64, Base64.DEFAULT), Charsets.UTF_8)
        }.getOrNull()?.takeIf { it.startsWith("https://", ignoreCase = true) } ?: return Result.failure()

        return try {
            val post = readNewestPost(feedUrl) ?: return Result.retry()
            val preferences = applicationContext.getSharedPreferences("post_notifications", Context.MODE_PRIVATE)
            val preferenceKey = "latest_${feedUrl.hashCode()}"
            val previousId = preferences.getString(preferenceKey, null)
            if (previousId == null) {
                preferences.edit().putString(preferenceKey, post.id).apply()
                return Result.success()
            }
            if (previousId == post.id) return Result.success()
            if (!hasNotificationPermission()) return Result.success()

            ensureChannel()
            val openPost = Intent(applicationContext, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_POST_URL, post.link)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pendingIntent = PendingIntent.getActivity(
                applicationContext,
                post.id.hashCode(),
                openPost,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(post.title.ifBlank { "A new post is available" })
                .setContentText("Tap to read the latest post")
                .setStyle(NotificationCompat.BigTextStyle().bigText(post.title.ifBlank { "A new post is available" }))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
            NotificationManagerCompat.from(applicationContext).notify(NOTIFICATION_ID, notification)
            preferences.edit().putString(preferenceKey, post.id).apply()
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "New posts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Updates when a new post appears in the selected public feed"
                },
            )
        }
    }

    private fun readNewestPost(feedUrl: String): FeedPost? {
        var currentUrl = URL(feedUrl)
        repeat(4) { redirectNumber ->
            require(currentUrl.protocol.equals("https", ignoreCase = true))
            val connection = currentUrl.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 12_000
            connection.setRequestProperty("Accept", "application/atom+xml, application/rss+xml, application/xml, text/xml")
            connection.setRequestProperty("User-Agent", "Web2AppPostChecker/1.0")
            try {
                val status = connection.responseCode
                if (status in 300..399) {
                    val location = connection.getHeaderField("Location") ?: return null
                    currentUrl = URL(currentUrl, location)
                    require(currentUrl.protocol.equals("https", ignoreCase = true))
                    if (redirectNumber == 3) return null
                    return@repeat
                }
                if (status !in 200..299) return null
                val bytes = connection.inputStream.use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    var total = 0
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_FEED_BYTES) throw IllegalArgumentException("Feed is too large")
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                return parseNewestPost(bytes, currentUrl)
            } finally {
                connection.disconnect()
            }
        }
        return null
    }

    private fun parseNewestPost(bytes: ByteArray, baseUrl: URL): FeedPost? {
        val parser = Xml.newPullParser()
        parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
        parser.setInput(ByteArrayInputStream(bytes), null)
        var rootName: String? = null
        var depth = 0
        var title = ""
        var id = ""
        var link = ""
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            when (parser.eventType) {
                XmlPullParser.START_TAG -> {
                    val name = parser.name.lowercase()
                    if (rootName == null && name in setOf("item", "entry")) {
                        rootName = name
                        depth = 1
                    } else if (rootName != null) {
                        depth++
                        when (name) {
                            "title" -> {
                                title = parser.nextText().trim()
                                depth--
                            }
                            "guid", "id" -> {
                                id = parser.nextText().trim()
                                depth--
                            }
                            "link" -> {
                                val href = parser.getAttributeValue(null, "href")
                                val rel = parser.getAttributeValue(null, "rel")
                                val candidate = href ?: parser.nextText().trim().also { depth-- }
                                if (link.isBlank() || rel == null || rel == "alternate") link = candidate
                            }
                        }
                    }
                }
                XmlPullParser.END_TAG -> if (rootName != null) {
                    depth--
                    if (depth <= 0) break
                }
            }
        }
        if (link.isBlank()) link = id
        val resolvedLink = runCatching { URL(baseUrl, link) }.getOrNull()
            ?.takeIf { it.protocol.equals("https", ignoreCase = true) }?.toString() ?: return null
        if (id.isBlank()) id = resolvedLink.ifBlank { title }
        if (id.isBlank()) return null
        return FeedPost(id, title, resolvedLink)
    }

    private data class FeedPost(val id: String, val title: String, val link: String)

    companion object {
        private const val CHANNEL_ID = "new_posts"
        private const val NOTIFICATION_ID = 7301
        private const val MAX_FEED_BYTES = 1_000_000
        private const val INITIAL_CHECK_WORK_NAME = "new_post_notifications_initial_check"
        private const val PERIODIC_WORK_NAME = "new_post_notifications"

        fun schedule(context: Context) {
            if (!BuildConfig.POST_NOTIFICATIONS_ENABLED) return
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                INITIAL_CHECK_WORK_NAME,
                androidx.work.ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<FeedNotificationWorker>().setConstraints(constraints).build(),
            )
            val request = PeriodicWorkRequestBuilder<FeedNotificationWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
