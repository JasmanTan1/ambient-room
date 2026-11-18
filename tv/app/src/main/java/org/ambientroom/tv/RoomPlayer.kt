package org.ambientroom.tv

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/** All methods run on the main thread. Media URLs are constructed from opaque IDs. */
class RoomPlayer(context: Context, private val api: BgmApi, network: RoomNetwork, token: String, onTrack: () -> Unit, onError: () -> Unit) {
    private val source = OkHttpDataSource.Factory(network.client).setDefaultRequestProperties(
        mapOf("Authorization" to "Bearer $token", "Cache-Control" to "no-store"))
    val player: ExoPlayer = ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(source))
        .setAudioAttributes(androidx.media3.common.AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true).build()
    private var playlistId: String? = null
    private var wanted: List<String> = emptyList()
    private var tracks: Map<String, Track> = emptyMap()
    init {
        player.repeatMode = Player.REPEAT_MODE_ALL
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                for (i in player.mediaItemCount - 1 downTo 0) {
                    if (i != player.currentMediaItemIndex && player.getMediaItemAt(i).mediaId !in wanted) player.removeMediaItem(i)
                }
                onTrack()
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) { onError() }
        })
    }
    private fun item(t: Track): MediaItem = MediaItem.Builder().setUri(api.streamUrl(t.id)).setMediaId(t.id)
        .setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.artist).build()).build()
    fun reconcile(s: Snapshot, fallback: Playlist?) {
        val active = s.activePlaylistId
        if (active == null) { playlistId = null; wanted = emptyList(); tracks = emptyMap(); player.stop(); player.clearMediaItems(); return }
        val queue = s.queue?.takeIf { it.playlistId == active }
        val target = queue?.tracks ?: fallback?.takeIf { it.id == active }?.tracks ?: return
        wanted = target.map(Track::id)
        val buffered = tracks[player.currentMediaItem?.mediaId]
        tracks = target.associateBy(Track::id)
        if (buffered != null && buffered.id !in tracks) tracks = tracks + (buffered.id to buffered)
        if (target.isEmpty()) { playlistId = active; player.pause(); player.clearMediaItems(); return }
        if (playlistId != active || player.mediaItemCount == 0) {
            playlistId = active
            val resume = s.resume?.takeIf { it.playlistId == active }
            val index = target.indexOfFirst { it.id == resume?.trackId }.coerceAtLeast(0)
            val position = if (target[index].id == resume?.trackId) ((resume.positionSec.coerceAtMost(target[index].durationSec)) * 1000).toLong() else 0
            player.setMediaItems(target.map(::item), index, position); player.prepare()
        } else {
            val old = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
            for (op in BgmQueue.ops(old, wanted, player.currentMediaItem?.mediaId, queue?.anchorId)) when (op) {
                is QueueOp.Remove -> player.removeMediaItem(op.index)
                is QueueOp.Move -> player.moveMediaItem(op.from, op.to)
                is QueueOp.Insert -> player.addMediaItem(op.index, item(tracks.getValue(op.id)))
            }
        }
        player.playWhenReady = !s.paused
    }
    fun next() { if (player.mediaItemCount > 0) player.seekToNextMediaItem() }
    fun sample(): Resume? {
        val id = playlistId ?: return null
        val track = player.currentMediaItem?.mediaId ?: return null
        if (track !in wanted) return null
        return Resume(id, track, (player.currentPosition.coerceAtLeast(0) / 1000.0).coerceAtMost(tracks[track]?.durationSec ?: Double.MAX_VALUE))
    }
    fun track(): Track? = tracks[player.currentMediaItem?.mediaId]
    fun retry() { player.prepare() }
    fun release() { player.release() }
}
