package org.ambientroom.tv

import android.content.Context

data class DeviceCredentials(val origin: CoordinatorOrigin, val allowHttp: Boolean, val deviceId: String,
    val token: String, val expiresAt: Long, val sessionId: String)

/** Private app storage, excluded from backup by the manifest. No inherited identity or data. */
class RoomStore(context: Context) {
    private val prefs = context.getSharedPreferences("ambient-room.v1.device", Context.MODE_PRIVATE)
    private val sequence = ResumeSequence({ prefs.getString("sessionId", null) to prefs.getLong("sampleN", 0) },
        { prefs.edit().putLong("sampleN", it).commit() })
    fun load(): DeviceCredentials? = runCatching {
        val origin = prefs.getString("origin", null) ?: return null
        val allow = prefs.getBoolean("allowHttp", false)
        DeviceCredentials(CoordinatorOrigin.parse(origin, allow), allow, prefs.getString("deviceId", null) ?: return null,
            prefs.getString("token", null) ?: return null, prefs.getLong("expiresAt", 0), prefs.getString("sessionId", null) ?: return null)
    }.getOrNull()
    @Synchronized fun save(origin: CoordinatorOrigin, allowHttp: Boolean, pair: PairResult.Ready) {
        check(prefs.edit().clear().putString("origin", origin.value).putBoolean("allowHttp", allowHttp)
            .putString("deviceId", pair.deviceId).putString("token", pair.token).putLong("expiresAt", pair.expiresAt)
            .putString("sessionId", pair.sessionId).putLong("sampleN", 0).commit())
    }
    /** Commit before sending: a crash may skip a sample number, but can never reuse one. */
    @Synchronized fun nextSample(sessionId: String): Long {
        return sequence.next(sessionId)
    }
    @Synchronized fun clear() { check(prefs.edit().clear().commit()) }
}
