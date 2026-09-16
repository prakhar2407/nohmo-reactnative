package com.nohmo

import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.MessageDigest

/**
 * A device identity that survives the app being deleted and reinstalled.
 *
 * The SDK's own device id lives in AsyncStorage, which Android wipes with the app
 * data on uninstall. Reinstalling therefore produced a brand-new anonymous device
 * every time, with no way for the backend to tell it was the same phone.
 *
 * ANDROID_ID is the only value that outlives an uninstall without Play Services or
 * a permission. Since Android 8.0 it is already scoped per app-signing-key, per
 * user, per device; it resets only on a factory reset, which is precisely the
 * point at which we *should* forget the device.
 *
 * We send a SHA-256 of it salted with the package name rather than the raw value:
 *   · below API 26 the raw id is device-wide, so hashing keeps one app from being
 *     correlated with another's data by anyone who sees both;
 *   · it means no hardware-scoped identifier ever leaves the device.
 * The hash is deterministic, so matching on the backend is unaffected.
 */
class NohmoStableIdModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "NohmoStableId"

    @ReactMethod
    fun getStableId(promise: Promise) {
        // Never reject: init() awaits this, and a device with no usable ANDROID_ID
        // should fall back to the old per-install behaviour rather than fail to
        // start up. An empty string tells the SDK to send no stableId.
        try {
            val androidId = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
            if (androidId.isNullOrBlank() || androidId == KNOWN_BAD_ANDROID_ID) {
                promise.resolve("")
                return
            }
            promise.resolve(sha256("$androidId:${reactContext.packageName}"))
        } catch (t: Throwable) {
            promise.resolve("")
        }
    }

    private fun sha256(input: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    companion object {
        /**
         * Burned into the ROM of a batch of early devices, so it identifies a model
         * rather than a phone. Treating it as stable would merge every one of those
         * devices in a project into a single row.
         */
        private const val KNOWN_BAD_ANDROID_ID = "9774d56d682e549c"
    }
}
