package org.ambientroom.tv

import kotlinx.serialization.json.*

data class PairStarted(val pairId: String, val userCode: String, val claimSecret: String, val expiresAt: Long, val pollAfterSec: Int)
sealed interface PairResult {
    data class Pending(val expiresAt: Long) : PairResult
    data class Ready(val deviceId: String, val token: String, val expiresAt: Long, val sessionId: String, val snapshot: Snapshot) : PairResult
}
data class PartyQr(val enabled: Boolean, val active: Boolean, val url: String?, val expiresAt: Long?, val serverNow: Long)

/** Closed v1 shapes. Numeric aliases, lenient JSON, unknown fields and omitted nullable fields are refused. */
object BgmWire {
    private val json = Json { isLenient = false; ignoreUnknownKeys = false }
    private val idPattern = Regex("^[A-Za-z0-9_-]{1,128}$")
    private const val MAX_INT = 9007199254740991L
    private fun JsonElement.obj(vararg fields: String): JsonObject = (this as JsonObject).also {
        require(it.keys == fields.toSet()) { "Unexpected response shape" }
    }
    private fun JsonElement.string(max: Int = Int.MAX_VALUE): String = (this as JsonPrimitive).also { require(it.isString) }.content.also {
        require(it.codePointCount(0, it.length) <= max)
    }
    private fun JsonElement.long(min: Long = 0, max: Long = MAX_INT): Long = (this as JsonPrimitive).also { require(!it.isString) }.long.also { require(it in min..max) }
    private fun JsonElement.number(min: Double = 0.0, max: Double = Double.MAX_VALUE): Double = (this as JsonPrimitive).also { require(!it.isString) }.double.also { require(it.isFinite() && it in min..max) }
    private fun JsonElement.bool(): Boolean = (this as JsonPrimitive).also { require(!it.isString) }.boolean
    private fun JsonElement.id(): String = string(128).also { require(idPattern.matches(it)) }
    private fun <T> JsonElement.nullable(parse: (JsonElement) -> T): T? = if (this == JsonNull) null else parse(this)
    private fun JsonObject.at(key: String) = getValue(key)
    private fun JsonElement.scene(): String = string().also { require(it in Scenes.ids) }
    private fun JsonElement.gain(): Double? = nullable { it.number(-60.0, 20.0) }
    private fun JsonElement.track(): Track {
        val o = obj("id", "title", "artist", "durationSec", "gainDb")
        return Track(o.at("id").id(), o.at("title").string(300), o.at("artist").string(300), o.at("durationSec").number(), o.at("gainDb").gain())
    }
    private fun JsonElement.tracks(): List<Track> = (this as JsonArray).also { require(it.size <= 5000) }.map { it.track() }.also {
        require(it.map(Track::id).distinct().size == it.size)
    }
    private fun JsonElement.snapshot(): Snapshot {
        val o = obj("roomId", "seq", "serverNow", "tvConnected", "playlists", "activePlaylistId", "resume", "paused", "timer", "queue", "message", "picture", "volume", "cmd", "gainRev", "gains")
        val lists = (o.at("playlists") as JsonArray).map { e ->
            val p = e.obj("id", "name", "scene", "trackCount")
            PlaylistInfo(p.at("id").id(), p.at("name").string(200), p.at("scene").scene(), p.at("trackCount").long())
        }
        val resume = o.at("resume").nullable { e ->
            val r = e.obj("playlistId", "trackId", "positionSec")
            Resume(r.at("playlistId").id(), r.at("trackId").id(), r.at("positionSec").number())
        }
        val timer = o.at("timer").nullable { e ->
            val t = e.obj("id", "endsAt", "durationSec")
            RoomTimer(t.at("id").id(), t.at("endsAt").long(), t.at("durationSec").long(60, 14400))
        }
        val queue = o.at("queue").nullable { e ->
            val q = e.obj("playlistId", "custom", "tracks", "anchorId")
            Queue(q.at("playlistId").id(), q.at("custom").bool(), q.at("tracks").tracks(), q.at("anchorId").nullable { it.id() })
        }
        val message = o.at("message").nullable { e ->
            val m = e.obj("text", "style", "expiresAt")
            val text = Greeting.clean(m.at("text").string(60)) ?: error("Invalid message")
            RoomMessage(text, m.at("style").string().also { require(it in listOf("banner", "card", "confetti")) }, m.at("expiresAt").long())
        }
        val pic = o.at("picture").obj("scene", "uploadId")
        val picture = Picture(pic.at("scene").nullable { it.scene() }, pic.at("uploadId").nullable { it.id() })
        require(picture.scene == null || picture.uploadId == null)
        val cmd = o.at("cmd").nullable { e ->
            val c = e.obj("n", "action")
            Command(c.at("n").long(1), c.at("action").string().also { require(it in listOf("play", "pause", "next")) })
        }
        val gains = (o.at("gains") as JsonArray).map { e ->
            val g = e.obj("id", "gainDb"); Gain(g.at("id").id(), g.at("gainDb").gain())
        }
        return Snapshot(o.at("roomId").id(), o.at("seq").long(), o.at("serverNow").long(), o.at("tvConnected").bool(), lists,
            o.at("activePlaylistId").nullable { it.id() }, resume, o.at("paused").bool(), timer, queue, message, picture,
            o.at("volume").long(0, 100).toInt(), cmd, o.at("gainRev").long(), gains)
    }
    fun state(raw: String): Snapshot = json.parseToJsonElement(raw).snapshot()
    fun playlist(raw: String): Playlist {
        val p = json.parseToJsonElement(raw).obj("id", "name", "scene", "tracks")
        return Playlist(p.at("id").id(), p.at("name").string(200), p.at("scene").scene(), p.at("tracks").tracks())
    }
    fun pairStarted(raw: String): PairStarted {
        val p = json.parseToJsonElement(raw).obj("pairId", "userCode", "claimSecret", "expiresAt", "pollAfterSec")
        return PairStarted(p.at("pairId").id(), p.at("userCode").string().also { require(Regex("^[A-Z2-9]{8}$").matches(it)) },
            p.at("claimSecret").string(256).also { require(it.length >= 16) }, p.at("expiresAt").long(), p.at("pollAfterSec").long(2, 10).toInt())
    }
    fun pairResult(raw: String): PairResult {
        val e = json.parseToJsonElement(raw) as JsonObject
        return if (e.at("status").string() == "pending") {
            val p = e.obj("status", "expiresAt"); PairResult.Pending(p.at("expiresAt").long())
        } else {
            val p = e.obj("status", "deviceId", "deviceToken", "expiresAt", "sessionId", "snapshot")
            require(p.at("status").string() == "paired")
            PairResult.Ready(p.at("deviceId").id(), p.at("deviceToken").string(256).also { require(it.length >= 16) },
                p.at("expiresAt").long(), p.at("sessionId").id(), p.at("snapshot").snapshot())
        }
    }
    fun party(raw: String): PartyQr {
        val p = json.parseToJsonElement(raw).obj("enabled", "active", "url", "expiresAt", "serverNow")
        return PartyQr(p.at("enabled").bool(), p.at("active").bool(), p.at("url").nullable { it.string(512) }, p.at("expiresAt").nullable { it.long() }, p.at("serverNow").long())
    }
    fun completion(raw: String): Snapshot {
        val c = json.parseToJsonElement(raw).obj("ok", "ignored", "snapshot")
        require(c.at("ok").bool()); c.at("ignored").bool(); return c.at("snapshot").snapshot()
    }
    fun resumeResult(raw: String): Boolean {
        val r = json.parseToJsonElement(raw).obj("ok", "stored"); require(r.at("ok").bool()); return r.at("stored").bool()
    }
    fun body(vararg values: Pair<String, Any?>): String = buildJsonObject {
        for ((key, value) in values) when (value) {
            null -> put(key, JsonNull)
            is Boolean -> put(key, value)
            is Number -> put(key, value)
            is String -> put(key, value)
            else -> error("Unsupported body field")
        }
    }.toString()
    fun validId(id: String): String = id.also { require(idPattern.matches(it)) }
}

object Scenes {
    val ids = listOf("calm", "nightcity", "rain", "cafe", "festival", "kpop")
    fun id(value: String?): String = value?.takeIf { it in ids } ?: "calm"
}
