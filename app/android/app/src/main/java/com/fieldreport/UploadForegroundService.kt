package com.fieldreport

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the upload engine running while the app is in the background.
 *
 * Two things stop a backgrounded RN app from uploading, and this addresses both:
 *  1. Android freezes the process -> a foreground service (with its notification) prevents it.
 *  2. React Native pauses every JS timer when the activity pauses, and `fetch` resolves through
 *     setTimeout, so requests would hang -> running a headless JS task re-enables the timers.
 *
 * The JS task ("UploadKeepAlive", see keepAlive.ts) stays open until nothing is pending; when
 * it finishes, HeadlessJsTaskService stops this service by itself.
 */
class UploadForegroundService : HeadlessJsTaskService() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      startAsForeground()
    } catch (e: Exception) {
      // Android refused (e.g. started from the background). Better to do nothing than crash.
      stopSelf()
      return START_NOT_STICKY
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      "UploadKeepAlive",
      Arguments.createMap(),
      0, // no timeout: it ends when the queue is empty
      true, // the app is usually in the foreground when this starts
    )

  private fun startAsForeground() {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Field Report")
      .setContentText("Uploading your saved reports. They stay safe on this device until the server confirms.")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Report uploads", NotificationManager.IMPORTANCE_LOW),
      )
    }
  }

  companion object {
    const val CHANNEL_ID = "uploads"
    const val NOTIFICATION_ID = 4201
  }
}
