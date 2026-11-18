package org.ambientroom.tv

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

class ClientTest {
    private val origin = CoordinatorOrigin.parse("https://coordinator.example")
    private fun rejected(block: () -> Unit) { try { block(); fail("Expected rejection") } catch (_: IllegalArgumentException) { } catch (_: IllegalStateException) { } catch (_: ClassCastException) { } }
    @Test fun originDefaultsToTlsAndRejectsUnsafeShapes() {
        for (value in listOf("http://coordinator.example", "https://fixture@invalid.", "https://coordinator.example/api", "https://coordinator.example?q=x", "https://coordinator.example#x", "file:///tmp/room")) rejected { CoordinatorOrigin.parse(value) }
    }
    @Test fun httpRequiresExplicitOptIn() {
        assertEquals("http://coordinator.example", CoordinatorOrigin.parse("http://coordinator.example/", true).value)
        assertFalse(origin.sameOrigin("http://coordinator.example/v1/state")); assertFalse(origin.sameOrigin("https://other.example/v1/state"))
    }
    @Test fun portsArePartOfOrigin() {
        assertTrue(origin.sameOrigin("https://coordinator.example:443/v1/state")); assertFalse(origin.sameOrigin("https://coordinator.example:444/v1/state"))
    }
    @Test fun snapshotAndPlaylistReadFrozenFixtures() {
        val s = snapshot(); assertEquals("playlist_demo", s.activePlaylistId); assertEquals(3, s.queue!!.tracks.size)
        assertEquals(12.5, s.resume!!.positionSec, .001); assertEquals(3, BgmWire.playlist(fixture("playlist.json")).tracks.size)
    }
    private fun mutate(field: String, element: JsonElement): String = JsonObject(Json.parseToJsonElement(fixture("snapshot.json")).jsonObject + (field to element)).toString()
    @Test fun unknownFieldsAreRejected() { rejected { BgmWire.state(mutate("online", JsonPrimitive(true))) } }
    @Test fun numericIdsAreRejected() { rejected { BgmWire.state(mutate("activePlaylistId", JsonPrimitive(1))) } }
    @Test fun omittedNullableFieldIsRejected() {
        val o = Json.parseToJsonElement(fixture("snapshot.json")).jsonObject
        rejected { BgmWire.state(JsonObject(o - "message").toString()) }
    }
    @Test fun outOfRangeVolumesAreRejected() { for (v in listOf(-1, 101)) rejected { BgmWire.state(mutate("volume", JsonPrimitive(v))) } }
    @Test fun nonIntegerAndStringRevisionsAreRejected() {
        rejected { BgmWire.state(mutate("seq", JsonPrimitive(1.5))) }; rejected { BgmWire.state(mutate("seq", JsonPrimitive("10"))) }
    }
    @Test fun mutuallyExclusivePictureFieldsAreRejected() {
        rejected { BgmWire.state(mutate("picture", buildJsonObject { put("scene", "calm"); put("uploadId", "photo_1") })) }
    }
    @Test fun responseErrorDoesNotExposeBody() {
        val api = BgmApi(origin) { ApiResponse(401, "sensitive deployment detail") }
        try { api.state("fixture_device_token"); fail("Expected 401") } catch (e: ApiFailure) { assertEquals(401, e.status); assertFalse(e.message!!.contains("sensitive")) }
    }
    @Test fun rateLimitCarriesRetryAfter() {
        val api = BgmApi(origin) { ApiResponse(429, "", 60) }
        try { api.state("fixture_device_token"); fail("Expected 429") } catch (e: ApiFailure) { assertEquals(60, e.retryAfterSec) }
    }
    @Test fun stateLongPollUsesFrozenQueryAndTimeout() {
        var request: ApiRequest? = null
        val api = BgmApi(origin) { r -> request = r; ApiResponse(200, fixture("snapshot.json")) }
        api.state("fixture_device_token", 10)
        assertEquals("https://coordinator.example/v1/state?since=10&waitSec=25", request!!.url)
        assertEquals(35, request!!.timeoutSec); assertEquals("Bearer fixture_device_token", request!!.headers["Authorization"])
        assertFalse(request!!.headers.containsKey("Idempotency-Key"))
    }
    @Test fun ownControlRetryKeepsSameMutationKey() {
        val requests = mutableListOf<ApiRequest>()
        val api = BgmApi(origin) { r -> requests += r; ApiResponse(200, fixture("snapshot.json")) }
        repeat(2) { api.control("fixture_device_token", "next", "same_mutation") }
        assertEquals(requests[0], requests[1]); assertEquals("same_mutation", requests[0].headers["Idempotency-Key"])
        assertEquals("/v1/playback/control", java.net.URI(requests[0].url).path)
    }
    @Test fun startPreservesOpaqueStringId() {
        var body: String? = null
        val api = BgmApi(origin) { body = it.body; ApiResponse(200, fixture("snapshot.json")) }
        api.start("fixture_device_token", "playlist_demo"); assertEquals("playlist_demo", Json.parseToJsonElement(body!!).jsonObject.getValue("playlistId").jsonPrimitive.content)
    }
    @Test fun timerBoundsRejectedBeforeTransport() {
        val api = BgmApi(origin) { error("Must not send") }
        for (minutes in listOf(0, 241)) rejected { api.setTimer("fixture_device_token", minutes) }
    }
    @Test fun completionUsesMatchingTimerIdEndpoint() {
        var request: ApiRequest? = null
        val api = BgmApi(origin) { request = it; ApiResponse(200, """{"ok":true,"ignored":false,"snapshot":${fixture("snapshot.json")}}""") }
        api.completeTimer("fixture_device_token", "timer_demo", "timer_complete_1")
        assertTrue(request!!.url.endsWith("/v1/timer/complete")); assertEquals("timer_demo", Json.parseToJsonElement(request!!.body!!).jsonObject.getValue("timerId").jsonPrimitive.content)
    }
    @Test fun resumeUsesSessionAndSampleCounter() {
        var request: ApiRequest? = null
        val api = BgmApi(origin) { request = it; ApiResponse(200, """{"ok":true,"stored":true}""") }
        assertTrue(api.resume("fixture_device_token", Resume("playlist_demo", "track_1", 12.5), true, "session_demo", 23))
        val b = Json.parseToJsonElement(request!!.body!!).jsonObject
        assertEquals(setOf("playlistId", "trackId", "positionSec", "paused", "sessionId", "sampleN"), b.keys)
        assertEquals(23, b.getValue("sampleN").jsonPrimitive.int); assertTrue(b.getValue("paused").jsonPrimitive.boolean)
    }
    @Test fun invalidSampleNeverReachesNetwork() {
        val api = BgmApi(origin) { error("Must not send") }
        rejected { api.resume("fixture_device_token", Resume("playlist_demo", "track_1", -1.0), false, "session_demo", 1) }
        rejected { api.resume("fixture_device_token", Resume("playlist_demo", "track_1", 1.0), false, "session_demo", 0) }
    }
    @Test fun invalidMediaIdsCannotInjectPath() {
        val api = BgmApi(origin) { error("Must not send") }
        for (id in listOf("../file", "track?token=x", "https://other.example")) rejected { api.streamUrl(id) }
        assertEquals("https://coordinator.example/v1/tracks/track_1/stream", api.streamUrl("track_1"))
    }
    @Test fun pairingStartHasNoDeviceBearer() {
        var req: ApiRequest? = null
        val api = BgmApi(origin) { req = it; ApiResponse(200, """{"pairId":"pair_demo","userCode":"ABCD2345","claimSecret":"fixture_claim_secret_0001","expiresAt":1800000300000,"pollAfterSec":2}""") }
        assertEquals(2, api.beginPairing().pollAfterSec); assertFalse(req!!.headers.containsKey("Authorization")); assertFalse(req!!.headers.containsKey("Idempotency-Key"))
    }
    @Test fun pairingClaimSendsSecretOnlyInBody() {
        var req: ApiRequest? = null
        val pair = PairStarted("pair_demo", "ABCD2345", "fixture_claim_secret_0001", 1800000300000, 2)
        val api = BgmApi(origin) { req = it; ApiResponse(200, """{"status":"pending","expiresAt":1800000300000}""") }
        assertTrue(api.claim(pair) is PairResult.Pending); assertFalse(req!!.url.contains(pair.claimSecret)); assertFalse(req!!.body!!.contains(pair.userCode))
        assertEquals(pair.claimSecret, Json.parseToJsonElement(req!!.body!!).jsonObject.getValue("claimSecret").jsonPrimitive.content)
    }
    @Test fun pairingReadyCarriesSnapshotAndLifetime() {
        val ready = BgmWire.pairResult("""{"status":"paired","deviceId":"device_demo","deviceToken":"fixture_device_token_0001","expiresAt":1802592000000,"sessionId":"session_demo","snapshot":${fixture("snapshot.json")}}""") as PairResult.Ready
        assertEquals("session_demo", ready.sessionId); assertEquals(snapshot(), ready.snapshot)
    }
    @Test fun pairingPollCannotBeFasterThanTwoSeconds() {
        rejected { BgmWire.pairStarted("""{"pairId":"pair_demo","userCode":"ABCD2345","claimSecret":"fixture_claim_secret_0001","expiresAt":1800000300000,"pollAfterSec":1}""") }
    }
    @Test fun qrUsesFragmentAndExpiresOffline() {
        val tracker = GuestQrTracker(origin); val q = BgmWire.party(fixture("party-qr.json"))
        tracker.update(q, 10); assertNotNull(tracker.current(11)); assertNull(tracker.current(43_200_010))
    }
    @Test fun delayedQrReadNeverExtendsSameToken() {
        val tracker = GuestQrTracker(origin); val q = PartyQr(true, true, "https://coordinator.example/guest#t=fixture_party_token_0001", 5000, 1000)
        tracker.update(q, 10); tracker.update(q, 2000); assertNull(tracker.current(4010))
    }
    @Test fun qrRejectsForeignOriginAndQueryTokens() {
        val tracker = GuestQrTracker(origin)
        for (url in listOf("https://other.example/guest#t=fixture_party_token_0001", "https://coordinator.example/guest?t=fixture_party_token_0001", "http://coordinator.example/guest#t=fixture_party_token_0001")) {
            tracker.update(PartyQr(true, true, url, 5000, 1000), 10); assertNull(tracker.current(11))
        }
    }
    @Test fun disableOrStopRemovesQrImmediately() {
        val tracker = GuestQrTracker(origin); val q = BgmWire.party(fixture("party-qr.json"))
        tracker.update(q, 10); tracker.update(q.copy(enabled = false), 11); assertNull(tracker.current(12))
        tracker.update(q, 20); tracker.update(q.copy(active = false), 21); assertNull(tracker.current(22))
    }
    @Test fun newPartyReplacesOldLifetime() {
        val tracker = GuestQrTracker(origin); val q = PartyQr(true, true, "https://coordinator.example/guest#t=fixture_party_token_0001", 5000, 1000)
        tracker.update(q, 10); val next = q.copy(url = "https://coordinator.example/guest#t=fixture_party_token_0002", expiresAt = 9000)
        tracker.update(next, 20); assertEquals(next.url, tracker.current(5000))
    }
    @Test fun renderedQrDecodesToExactFragmentUrl() {
        val url = BgmWire.party(fixture("party-qr.json")).url!!
        val image = GuestQr.pixels(url)
        val source = com.google.zxing.RGBLuminanceSource(image.width, image.height, image.pixels)
        val result = com.google.zxing.MultiFormatReader().decode(com.google.zxing.BinaryBitmap(com.google.zxing.common.HybridBinarizer(source)))
        assertEquals(url, result.text); assertTrue(result.text.contains("/guest#t="))
    }
}

@RunWith(Parameterized::class)
class FrozenVectorTest(private val vector: JsonObject) {
    @Test fun frozenTransition() {
        val input = vector.getValue("input").jsonObject; val expected = vector.getValue("expected").jsonObject
        when (vector.getValue("domain").jsonPrimitive.content) {
            "deadline" -> {
                val start = input.getValue("localMonotonic").jsonPrimitive.long
                val deadline = Lifetime.deadline(input.getValue("expiresAt").jsonPrimitive.long, input.getValue("serverNow").jsonPrimitive.long, start)
                val now = start + input.getValue("elapsedMs").jsonPrimitive.long
                assertEquals(expected.getValue("visible").jsonPrimitive.boolean, now < deadline)
                assertEquals(expected.getValue("remainingMs").jsonPrimitive.long, (deadline - now).coerceAtLeast(0))
            }
            "timer_schedule" -> {
                val machine = BgmTimerMachine(); machine.update(RoomTimer("timer_demo", 1000, 60), 0, 0, 0)
                val chimes = mutableListOf<Long>(); var finished = false
                val elapsed = input.getValue("elapsedMs").jsonPrimitive.long
                for (t in 0L..elapsed step 100) for (event in machine.step(1000 + t)) when (event) {
                    is TimerEvent.Chime -> chimes += t
                    is TimerEvent.Finished -> finished = true
                }
                assertEquals(expected.getValue("chimeTimesMs").jsonArray.map { it.jsonPrimitive.long }, chimes)
                assertEquals(expected.getValue("finished").jsonPrimitive.boolean, finished)
                assertEquals(1f, machine.volume(1000 + elapsed), .0001f)
            }
            "message" -> assertEquals(expected.getValue("text").let { if (it == JsonNull) null else it.jsonPrimitive.content }, Greeting.clean(input.getValue("raw").jsonPrimitive.content))
            "command" -> {
                val entering = input.getValue("entering").jsonPrimitive.boolean
                val sync = BgmSync(); val s = snapshot()
                if (!entering) sync.accept(s.copy(cmd = Command(input.getValue("seenN").jsonPrimitive.long, "next")))
                val result = sync.accept(s.copy(seq = s.seq + 1, cmd = Command(input.getValue("incomingN").jsonPrimitive.long, "next")))!!
                assertEquals(expected.getValue("execute").jsonPrimitive.boolean, result.command != null)
            }
        }
    }
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{index}: {0}") fun cases(): List<Array<Any>> = Json.parseToJsonElement(fixture("transition-cases.json")).jsonArray
            .map { it.jsonObject }.filter { it.getValue("domain").jsonPrimitive.content in listOf("message", "command", "deadline", "timer_schedule") }.map { arrayOf<Any>(it) }
    }
}
