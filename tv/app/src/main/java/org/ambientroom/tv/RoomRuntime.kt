package org.ambientroom.tv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.Request
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

private object RoomIo { val writes = Executors.newSingleThreadScheduledExecutor() }

/** Independent state/QR workers; expiry and audio rendering remain on the main thread. */
class RoomRuntime(context: Context, val credentials: DeviceCredentials, private val store: RoomStore,
    private val changed: () -> Unit, private val revoked: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val poller = Executors.newSingleThreadScheduledExecutor()
    private val auxiliary = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var alive = true
    private val network = RoomNetwork(credentials.origin) { main.post { invalidate() } }
    val api = BgmApi(credentials.origin, network)
    val sync = BgmSync()
    val timer = BgmTimerMachine()
    val banner = MessageTracker()
    val qr = GuestQrTracker(credentials.origin)
    val media = RoomPlayer(context, api, network, credentials.token, { if (alive) sendResume() }, {
        retryAt = now() + minOf(30_000L, 2000L shl retryCount.coerceIn(0, 4)); retryCount++
        status = "Playback interrupted. Retrying…"
    })
    var status = "Connecting…"; private set
    var photo: Bitmap? = null; private set
    private var photoId: String? = null
    private var loadedPhotoId: String? = null
    @Volatile private var seq: Long? = null
    private var credentialDeadline: Long? = null
    private var lastResume = now()
    private var retryAt = Long.MAX_VALUE
    private var retryCount = 0
    private val timerPending = mutableSetOf<String>()
    private val chimeSamples = BgmChime.samples()
    private var chime: AudioTrack? = null
    private val tick = object : Runnable {
        override fun run() {
            if (!alive) return
            val time = now()
            if (credentialDeadline?.let { time >= it } == true) { invalidate(); return }
            for (event in timer.step(time)) when (event) {
                is TimerEvent.Chime -> if (sync.current?.volume == 0) Unit else ring()
                is TimerEvent.Finished -> if (timerPending.add(event.timerId)) mutation {
                    api.completeTimer(credentials.token, event.timerId, it)
                }
            }
            val state = sync.current
            val trackId = media.track()?.id
            val measured = sync.gains.firstOrNull { it.id == trackId }
            val gain = if (measured != null) measured.gainDb else media.track()?.gainDb
            media.player.volume = BgmVolume.mix(state?.volume ?: 0, timer.volume(time), gain)
            chime?.setVolume(BgmVolume.gain(state?.volume ?: 0))
            if (time - lastResume >= 15_000) sendResume()
            if (time >= retryAt) { retryAt = Long.MAX_VALUE; media.retry() }
            changed()
            main.postDelayed(this, 250)
        }
    }
    fun start() {
        main.post(tick)
        // A previous Activity's exit sample and stop finish before this Activity's first read.
        RoomIo.writes.execute { if (alive) {
            poller.execute { poll(BgmPollPace(), 0) }
            auxiliary.execute { pollQr() }
        } }
    }
    private fun post(block: () -> Unit) { main.post { if (alive) block() } }
    private fun schedule(worker: ScheduledExecutorService, delay: Long, block: () -> Unit) {
        if (alive && !worker.isShutdown) runCatching { worker.schedule({ if (alive) block() }, delay, TimeUnit.MILLISECONDS) }
    }
    private fun poll(pace: BgmPollPace, failures: Int) {
        if (!alive) return
        val began = now()
        var failed = failures
        var minimum = 0L
        try {
            val previous = seq
            val s = api.state(credentials.token, previous, pace.longPolling)
            pace.note(now() - began, s.seq != previous)
            val fallback = if (s.activePlaylistId != null && s.queue == null) api.playlist(credentials.token, s.activePlaylistId) else null
            post { apply(s, began, fallback) }
            failed = 0
        } catch (e: Exception) {
            failed++
            minimum = (e as? ApiFailure)?.retryAfterSec?.times(1000L) ?: 0
            post { status = if (sync.current == null) "Cannot reach coordinator. Check setup or try again." else "Connection interrupted. Buffered playback continues."; changed() }
        }
        schedule(poller, maxOf(minimum, pace.gap(now() - began, failed))) { poll(pace, failed) }
    }
    private fun pollQr() {
        val began = now()
        var delay = 15_000L
        try {
            val q = api.party(credentials.token)
            post { qr.update(q, began); changed() }
        } catch (e: Exception) {
            delay = maxOf(delay, (e as? ApiFailure)?.retryAfterSec?.times(1000L) ?: 0)
        }
        schedule(auxiliary, delay) { pollQr() }
    }
    private fun apply(s: Snapshot, started: Long, fallback: Playlist? = null) {
        val update = sync.accept(s) ?: return
        seq = s.seq
        credentialDeadline = minOf(credentialDeadline ?: Long.MAX_VALUE,
            Lifetime.deadline(credentials.expiresAt, s.serverNow, started))
        if (now() >= credentialDeadline!!) { invalidate(); return }
        banner.update(s.message, s.serverNow, started)
        timer.update(s.timer, s.serverNow, started, now())
        media.reconcile(s, fallback)
        if (update.command == "next") media.next()
        // play/pause are represented by the authoritative paused field, including on entry.
        status = when {
            s.playlists.isEmpty() -> "Link a library playlist in the host remote."
            s.activePlaylistId == null -> "Choose a playlist and press Start."
            s.queue?.tracks?.isEmpty() == true -> "Queue is empty. Add tracks in the host remote."
            else -> ""
        }
        val nextPhoto = s.picture.uploadId
        if (nextPhoto != photoId) { photoId = nextPhoto; loadedPhotoId = null; photo = null }
        if (nextPhoto != null && loadedPhotoId != nextPhoto) fetchPhoto(nextPhoto)
        changed()
    }
    private fun fetchPhoto(id: String) {
        loadedPhotoId = id
        auxiliary.execute {
            val bitmap = runCatching {
                val request = Request.Builder().url(api.pictureUrl(id)).header("Authorization", "Bearer ${credentials.token}")
                    .header("Cache-Control", "no-store").build()
                network.client.newCall(request).execute().use { r ->
                    check(r.code == 200)
                    val source = r.body?.source() ?: error("No picture")
                    source.request(8_388_609)
                    check(source.buffer.size <= 8_388_608)
                    val bytes = source.readByteArray()
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    check(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 40_000_000)
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1920) sample *= 2
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                }
            }.getOrNull()
            post { if (photoId == id) { photo = bitmap; if (bitmap == null) loadedPhotoId = null; changed() } }
        }
    }
    private fun ring() {
        chime?.release()
        chime = AudioTrack.Builder().setAudioAttributes(android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(BgmChime.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(chimeSamples.size * 2).build().also {
                it.write(chimeSamples, 0, chimeSamples.size); it.setVolume(BgmVolume.gain(sync.current?.volume ?: 0)); it.play()
            }
    }
    fun mutation(operation: (String) -> Snapshot) {
        if (!alive) return
        val key = BgmApi.newKey()
        fun attempt(count: Int) {
            if (!alive) return
            val began = now()
            try {
                val s = operation(key)
                val fallback = if (s.activePlaylistId != null && s.queue == null) api.playlist(credentials.token, s.activePlaylistId) else null
                post { apply(s, began, fallback) }
            } catch (e: Exception) {
                val retry = e !is ApiFailure || e.status in listOf(429, 503)
                if (retry && count < 3) schedule(RoomIo.writes, maxOf(2000L shl count, (e as? ApiFailure)?.retryAfterSec?.times(1000L) ?: 0)) { attempt(count + 1) }
                else post { status = "Command could not be applied. Try again in the host remote."; changed() }
            }
        }
        RoomIo.writes.execute { attempt(0) }
    }
    fun startPlaylist(id: String?) = mutation { api.start(credentials.token, id, it) }
    fun control(action: String) = mutation { api.control(credentials.token, action, it) }
    fun setTimer(minutes: Int) = mutation { api.setTimer(credentials.token, minutes, it) }
    fun clearTimer() = mutation { api.clearTimer(credentials.token, it) }
    fun sendResume() {
        if (!alive) return
        lastResume = now()
        val r = media.sample() ?: return
        val paused = !media.player.playWhenReady
        val sampleN = runCatching { store.nextSample(credentials.sessionId) }.getOrNull() ?: return
        RoomIo.writes.execute { if (alive) runCatching {
            api.resume(credentials.token, r, paused, credentials.sessionId, sampleN)
        } }
    }
    private fun invalidate() {
        if (!alive) return
        close(sendStop = false)
        store.clear()
        revoked()
    }
    fun close(sendStop: Boolean = true) {
        if (!alive) return
        val r = media.sample()
        val paused = !media.player.playWhenReady
        val finalSampleN = if (r != null) runCatching { store.nextSample(credentials.sessionId) }.getOrNull() else null
        alive = false
        main.removeCallbacks(tick)
        poller.shutdownNow(); auxiliary.shutdownNow(); network.cancel()
        media.release(); chime?.release(); chime = null; photo = null
        if (sendStop) RoomIo.writes.execute {
            if (r != null && finalSampleN != null) runCatching { api.resume(credentials.token, r, paused, credentials.sessionId, finalSampleN) }
            runCatching { api.stop(credentials.token) }
        }
    }
    companion object { fun now(): Long = SystemClock.elapsedRealtime() }
}
