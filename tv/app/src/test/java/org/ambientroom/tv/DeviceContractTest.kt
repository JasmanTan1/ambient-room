package org.ambientroom.tv

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.net.URI
import java.io.File

/** Records actual client wire traffic to injected mocks for an optional schema validator. */
class DeviceContractTest {
    @Test fun allDeviceOperationsUseTheFrozenProtocol() {
        val traffic = mutableListOf<JsonObject>()
        val pair = """{"pairId":"pair_demo","userCode":"ABCD2345","claimSecret":"fixture_claim_secret_0001","expiresAt":1800000300000,"pollAfterSec":2}"""
        val api = BgmApi(CoordinatorOrigin.parse("https://coordinator.example")) { r ->
            val path = URI(r.url).path
            val response = when {
                path == "/v1/pairings" -> pair
                path.endsWith("/claim") -> """{"status":"pending","expiresAt":1800000300000}"""
                path == "/v1/playlists/playlist_demo" -> fixture("playlist.json")
                path == "/v1/party/qr" -> fixture("party-qr.json")
                path == "/v1/playback/resume" -> """{"ok":true,"stored":true}"""
                path == "/v1/timer/complete" -> """{"ok":true,"ignored":false,"snapshot":${fixture("snapshot.json")}}"""
                else -> fixture("snapshot.json")
            }
            traffic += buildJsonObject {
                put("method", r.method); put("url", r.url)
                put("headers", buildJsonObject { r.headers.forEach { (k, v) -> put(k, v) } })
                put("body", r.body?.let(Json::parseToJsonElement) ?: JsonNull)
                put("response", Json.parseToJsonElement(response))
            }
            ApiResponse(200, response)
        }
        val token = "fixture_device_token_0001"
        val started = api.beginPairing(); api.claim(started)
        api.state(token); api.state(token, 10); api.state(token, 10, false)
        api.playlist(token, "playlist_demo"); api.party(token)
        api.start(token, null); api.start(token, "playlist_demo"); api.stop(token)
        for (action in listOf("play", "pause", "next")) api.control(token, action)
        api.setTimer(token, 1); api.setTimer(token, 240); api.clearTimer(token)
        api.completeTimer(token, "timer_demo")
        api.resume(token, Resume("playlist_demo", "track_1", 12.5), false, "session_demo", 1)
        assertEquals(18, traffic.size)
        val authenticatedWrites = traffic.filter {
            !URI(it.getValue("url").jsonPrimitive.content).path.startsWith("/v1/pairings") && it.getValue("method").jsonPrimitive.content != "GET"
        }
        val keys = authenticatedWrites.map { it.getValue("headers").jsonObject.getValue("Idempotency-Key").jsonPrimitive.content }
        assertEquals(keys.size, keys.distinct().size)
        System.getProperty("ambient.room.contract.recording")?.let { File(it).writeText(JsonArray(traffic).toString()) }
    }
}
