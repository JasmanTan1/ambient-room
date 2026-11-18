package org.ambientroom.tv

import java.net.URI
import java.util.UUID

/** An origin has no installation path, credentials, query, or fragment. */
class CoordinatorOrigin private constructor(val value: String) {
    fun url(path: String): String = value + path.also { require(it.startsWith("/v1/") && !it.contains("..")) }
    fun sameOrigin(url: String): Boolean = runCatching {
        val u = URI(url); val base = URI(value)
        u.scheme == base.scheme && u.host == base.host && port(u) == port(base) && u.rawUserInfo == null
    }.getOrDefault(false)
    companion object {
        private fun port(u: URI) = if (u.port >= 0) u.port else if (u.scheme == "https") 443 else 80
        fun parse(raw: String, allowHttp: Boolean = false): CoordinatorOrigin {
            val uri = URI(raw.trim())
            require(uri.scheme == "https" || (allowHttp && uri.scheme == "http")) { "Use HTTPS or explicitly allow local HTTP" }
            require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
            require(uri.port == -1 || uri.port in 1..65535)
            return CoordinatorOrigin(raw.trim().trimEnd('/'))
        }
    }
}

data class ApiRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String?, val timeoutSec: Int = 15)
data class ApiResponse(val status: Int, val body: String, val retryAfterSec: Int? = null)
fun interface Transport { fun send(request: ApiRequest): ApiResponse }
class ApiFailure(val status: Int, val retryAfterSec: Int? = null) : Exception("Coordinator request failed ($status)")

/** Transport is injected; tests never create a real socket. No error body or endpoint enters logs. */
class BgmApi(val origin: CoordinatorOrigin, private val transport: Transport) {
    private fun call(method: String, path: String, token: String? = null, body: String? = null, key: String? = null, timeout: Int = 15): String {
        val headers = mutableMapOf("Accept" to "application/json", "Cache-Control" to "no-store")
        token?.let { headers["Authorization"] = "Bearer $it" }
        if (body != null) headers["Content-Type"] = "application/json"
        if (token != null && method != "GET") headers["Idempotency-Key"] = key ?: newKey()
        val response = transport.send(ApiRequest(method, origin.url(path), headers, body, timeout))
        if (response.status != 200) throw ApiFailure(response.status, response.retryAfterSec)
        return response.body
    }
    fun beginPairing(): PairStarted = BgmWire.pairStarted(call("POST", "/v1/pairings", body = BgmWire.body("deviceName" to "Room TV")))
    fun claim(pair: PairStarted): PairResult = BgmWire.pairResult(call("POST", "/v1/pairings/${BgmWire.validId(pair.pairId)}/claim", body = BgmWire.body("claimSecret" to pair.claimSecret)))
    fun state(token: String, since: Long? = null, wait: Boolean = true): Snapshot {
        val query = if (since == null) "" else "?since=${since.coerceAtLeast(0)}&waitSec=${if (wait) 25 else 0}"
        return BgmWire.state(call("GET", "/v1/state$query", token, timeout = if (wait && since != null) 35 else 15))
    }
    fun playlist(token: String, id: String): Playlist = BgmWire.playlist(call("GET", "/v1/playlists/${BgmWire.validId(id)}", token))
    fun party(token: String): PartyQr = BgmWire.party(call("GET", "/v1/party/qr", token))
    fun start(token: String, playlistId: String?, key: String = newKey()): Snapshot = BgmWire.state(call("POST", "/v1/playback/start", token,
        if (playlistId == null) "{}" else BgmWire.body("playlistId" to BgmWire.validId(playlistId)), key))
    fun stop(token: String, key: String = newKey()): Snapshot = BgmWire.state(call("POST", "/v1/playback/stop", token, key = key))
    fun control(token: String, action: String, key: String = newKey()): Snapshot {
        require(action in listOf("play", "pause", "next"))
        return BgmWire.state(call("POST", "/v1/playback/control", token, BgmWire.body("action" to action), key))
    }
    fun setTimer(token: String, minutes: Int, key: String = newKey()): Snapshot {
        require(minutes in 1..240)
        return BgmWire.state(call("POST", "/v1/timer", token, BgmWire.body("minutes" to minutes), key))
    }
    fun clearTimer(token: String, key: String = newKey()): Snapshot = BgmWire.state(call("DELETE", "/v1/timer", token, key = key))
    fun completeTimer(token: String, timerId: String, key: String = newKey()): Snapshot = BgmWire.completion(call("POST", "/v1/timer/complete", token, BgmWire.body("timerId" to BgmWire.validId(timerId)), key))
    fun resume(token: String, r: Resume, paused: Boolean, sessionId: String, sampleN: Long, key: String = newKey()): Boolean {
        require(sampleN in 1..9007199254740991L && r.positionSec.isFinite() && r.positionSec >= 0)
        return BgmWire.resumeResult(call("PUT", "/v1/playback/resume", token, BgmWire.body("playlistId" to BgmWire.validId(r.playlistId),
            "trackId" to BgmWire.validId(r.trackId), "positionSec" to r.positionSec, "paused" to paused,
            "sessionId" to BgmWire.validId(sessionId), "sampleN" to sampleN), key))
    }
    fun streamUrl(trackId: String): String = origin.url("/v1/tracks/${BgmWire.validId(trackId)}/stream")
    fun pictureUrl(uploadId: String): String = origin.url("/v1/pictures/${BgmWire.validId(uploadId)}")
    companion object { fun newKey(): String = UUID.randomUUID().toString() }
}

/** QR lifetime survives outages; URLs can only point at this room's configured origin. */
class GuestQrTracker(private val origin: CoordinatorOrigin) {
    var url: String? = null; private set
    private var deadline = 0L
    fun update(s: PartyQr, started: Long): String? {
        val link = s.url
        val u = link?.let { runCatching { URI(it) }.getOrNull() }
        if (!s.enabled || !s.active || link == null || s.expiresAt == null ||
            !origin.sameOrigin(link) || u?.rawPath != "/guest" || u.rawQuery != null ||
            u.rawFragment?.matches(Regex("t=[A-Za-z0-9_-]{16,256}")) != true || s.expiresAt <= s.serverNow) {
            url = null; deadline = 0; return null
        }
        val end = Lifetime.deadline(s.expiresAt, s.serverNow, started)
        deadline = if (url == link) minOf(deadline, end) else end
        url = link
        return url
    }
    fun current(now: Long): String? = url?.takeIf { now < deadline }
}
