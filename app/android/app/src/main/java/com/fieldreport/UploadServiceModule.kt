package com.fieldreport

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/** JS handle on [UploadForegroundService]. Resolves false instead of throwing if Android refuses. */
class UploadServiceModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "UploadService"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      ContextCompat.startForegroundService(ctx, Intent(ctx, UploadForegroundService::class.java))
      promise.resolve(true)
    } catch (e: Exception) {
      // e.g. started from the background on Android 12+. Uploads still run while foregrounded.
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    ctx.stopService(Intent(ctx, UploadForegroundService::class.java))
    promise.resolve(true)
  }
}

class UploadServicePackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(UploadServiceModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
