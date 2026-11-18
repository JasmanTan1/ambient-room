package org.ambientroom.tv

import java.text.Normalizer
import kotlin.math.pow

data class Track(val id: String, val title: String, val artist: String, val durationSec: Double, val gainDb: Double?)
data class PlaylistInfo(val id: String, val name: String, val scene: String, val trackCount: Long)
data class Playlist(val id: String, val name: String, val scene: String, val tracks: List<Track>)
data class Resume(val playlistId: String, val trackId: String, val positionSec: Double)
data class RoomTimer(val id: String, val endsAt: Long, val durationSec: Long)
data class RoomMessage(val text: String, val style: String, val expiresAt: Long)
data class Picture(val scene: String?, val uploadId: String?)
data class Command(val n: Long, val action: String)
data class Queue(val playlistId: String, val custom: Boolean, val tracks: List<Track>, val anchorId: String?)
data class Gain(val id: String, val gainDb: Double?)
data class Snapshot(
    val roomId: String, val seq: Long, val serverNow: Long, val tvConnected: Boolean,
    val playlists: List<PlaylistInfo>, val activePlaylistId: String?, val resume: Resume?, val paused: Boolean,
    val timer: RoomTimer?, val queue: Queue?, val message: RoomMessage?, val picture: Picture,
    val volume: Int, val cmd: Command?, val gainRev: Long, val gains: List<Gain>
)

/** Keeps revision and command authority separate from measured gains and expiring content. */
class BgmSync {
    var current: Snapshot? = null; private set
    private var commandSeen = 0L
    var gainRev = -1L; private set
    var gains: List<Gain> = emptyList(); private set
    data class Update(val snapshot: Snapshot, val command: String?, val gainsChanged: Boolean)
    fun accept(s: Snapshot, ownReply: Boolean = false): Update? {
        val previous = current
        if (previous != null && s.seq < previous.seq) return null
        val changed = s.gainRev > gainRev
        if (changed) { gainRev = s.gainRev; gains = s.gains }
        val action = if (previous == null || ownReply) null else s.cmd?.takeIf { it.n > commandSeen }?.action
        commandSeen = maxOf(commandSeen, s.cmd?.n ?: 0)
        // Paused/resume restore entry state. State reads never issue a start mutation.
        current = s
        return Update(s, action, changed)
    }
}

object Lifetime {
    fun deadline(expiresAt: Long, serverNow: Long, requestStarted: Long): Long =
        requestStarted + (expiresAt - serverNow).coerceIn(-86_400_000L, 31L * 86_400_000)
}

/** Server deadlines are translated at request-send time; repeated reads never extend them. */
class MessageTracker {
    private var message: RoomMessage? = null
    private var deadline = 0L
    fun update(m: RoomMessage?, serverNow: Long, started: Long) {
        if (m == null) { message = null; return }
        val end = Lifetime.deadline(m.expiresAt, serverNow, started)
        deadline = if (m == message) minOf(deadline, end) else end
        message = m
    }
    fun current(now: Long): RoomMessage? = message?.takeIf { now < deadline }
}

object Greeting {
    private val hidden = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200B\\u200E-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]")
    fun clean(raw: String): String? {
        val cleaned = Normalizer.normalize(raw.replace(hidden, " ").replace(Regex("(?U)\\s+"), " ").trim(), Normalizer.Form.NFC)
        return cleaned.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 60 }
    }
}

/** Durable counter allocation precedes network enqueue and survives renderer restarts. */
class ResumeSequence(private val read: () -> Pair<String?, Long>, private val write: (Long) -> Boolean) {
    @Synchronized fun next(sessionId: String): Long {
        val (storedSession, last) = read()
        check(storedSession == sessionId)
        val next = last + 1
        check(next in 1..9007199254740991L)
        check(write(next))
        return next
    }
}

object BgmVolume {
    fun gain(percent: Int): Float = (percent.coerceIn(0, 100) / 100f).let { it * it }
    fun mix(percent: Int, duck: Float, gainDb: Double?): Float =
        (gain(percent) * duck.coerceIn(0f, 1f) * 10.0.pow((gainDb ?: 0.0).coerceIn(-60.0, 0.0) / 20)).toFloat().coerceIn(0f, 1f)
}

object BgmTiming {
    const val DUCK_MS = 1200L
    const val CHIME_GAP_MS = 2400L
    const val HOLD_END_MS = 5600L
    const val END_PHASE_MS = 8100L
    const val STALE_MS = 20000L
    val PRESETS = listOf(5, 15, 30, 60)
}
sealed interface TimerEvent {
    data class Chime(val n: Int) : TimerEvent
    data class Finished(val timerId: String, val rang: Boolean) : TimerEvent
}

/** Completion is tied to an immutable ID, so late acknowledgments cannot cancel replacements. */
class BgmTimerMachine {
    var id: String? = null; private set
    var deadline: Long? = null; private set
    private val finished = mutableSetOf<String>()
    private var chimes = 0
    private var ringing = false
    fun update(timer: RoomTimer?, serverNow: Long, started: Long, now: Long) {
        if (timer == null) {
            if (ringing && id !in finished) return
            id?.let { finished += it }
            id = null; deadline = null; return
        }
        if (timer.id in finished) return
        val end = Lifetime.deadline(timer.endsAt, serverNow, started)
        if (timer.id == id) { deadline = minOf(deadline ?: end, end); return }
        id?.let { finished += it }
        id = timer.id; deadline = end; chimes = 0; ringing = false
    }
    fun remaining(now: Long): Long = if (id in finished) 0 else ((deadline ?: now) - now).coerceAtLeast(0)
    fun active(): Boolean = id != null && id !in finished
    fun volume(now: Long): Float {
        if (!active()) return 1f
        val elapsed = now - (deadline ?: return 1f)
        fun smooth(t: Float): Float = t.coerceIn(0f, 1f).let { it * it * (3 - 2 * it) }
        return when {
            elapsed <= 0 -> 1f
            elapsed < BgmTiming.DUCK_MS -> 1f - .8f * smooth(elapsed / 1200f)
            elapsed < BgmTiming.HOLD_END_MS -> .2f
            elapsed < BgmTiming.END_PHASE_MS -> .2f + .8f * smooth((elapsed - 5600) / 2500f)
            else -> 1f
        }
    }
    fun step(now: Long): List<TimerEvent> {
        val key = id ?: return emptyList()
        if (key in finished) return emptyList()
        val elapsed = now - (deadline ?: return emptyList())
        if (elapsed < 0) return emptyList()
        if (elapsed > BgmTiming.STALE_MS) { finished += key; return listOf(TimerEvent.Finished(key, false)) }
        ringing = true
        val result = mutableListOf<TimerEvent>()
        // If the scheduler misses an entire chime window, do not emit two overlapping bells.
        while (chimes < 2 && elapsed >= BgmTiming.DUCK_MS + chimes * BgmTiming.CHIME_GAP_MS) {
            chimes++
            if (elapsed < BgmTiming.DUCK_MS + chimes * BgmTiming.CHIME_GAP_MS) result += TimerEvent.Chime(chimes)
        }
        if (elapsed >= BgmTiming.END_PHASE_MS) { finished += key; result += TimerEvent.Finished(key, true) }
        return result
    }
}

sealed interface QueueOp {
    data class Remove(val index: Int) : QueueOp
    data class Move(val from: Int, val to: Int) : QueueOp
    data class Insert(val index: Int, val id: String) : QueueOp
}
/** Incremental edits preserve the buffered current item, including a removed current track. */
object BgmQueue {
    fun ops(player: List<String>, target: List<String>, currentId: String?, anchorId: String? = null): List<QueueOp> {
        val unique = target.distinct()
        val goal = if (currentId != null && currentId in player && currentId !in unique && unique.isNotEmpty()) {
            val oldIndex = player.indexOf(currentId)
            val next = unique.indexOf(anchorId).takeIf { it >= 0 }
                ?: unique.indexOfFirst { player.indexOf(it) > oldIndex }.takeIf { it >= 0 }
                ?: unique.size
            unique.take(next) + currentId + unique.drop(next)
        } else unique
        val work = player.toMutableList()
        val out = mutableListOf<QueueOp>()
        for (i in work.indices.reversed()) if (work[i] !in goal || work.indexOf(work[i]) != i) {
            out += QueueOp.Remove(i); work.removeAt(i)
        }
        for (i in goal.indices) {
            if (work.getOrNull(i) == goal[i]) continue
            val from = work.indexOf(goal[i])
            if (from >= 0) { out += QueueOp.Move(from, i); work.add(i, work.removeAt(from)) }
            else { out += QueueOp.Insert(i, goal[i]); work.add(i, goal[i]) }
        }
        return out
    }
    fun apply(player: List<String>, ops: List<QueueOp>): List<String> {
        val w = player.toMutableList()
        for (op in ops) when (op) {
            is QueueOp.Remove -> w.removeAt(op.index)
            is QueueOp.Move -> w.add(op.to, w.removeAt(op.from))
            is QueueOp.Insert -> w.add(op.index, op.id)
        }
        return w
    }
}

enum class BgmKey { Ok, PlayPause, Play, Pause, Next, Back, Left, Right, Up, Down, Menu, Other }
enum class BgmAction { Play, Pause, Next, Exit, TimerPick, TimerOff, None }
data class BgmMenuState(val open: Boolean = false, val index: Int = 1)
data class BgmKeyOut(val action: BgmAction, val consumed: Boolean, val menu: BgmMenuState, val minutes: Int? = null)
object BgmKeys {
    fun reduce(key: BgmKey, repeat: Int, dimmed: Boolean, playing: Boolean, menu: BgmMenuState, timerActive: Boolean): BgmKeyOut {
        val m = if (dimmed) BgmMenuState() else menu
        fun out(a: BgmAction = BgmAction.None, state: BgmMenuState = m, minutes: Int? = null) = BgmKeyOut(a, true, state, minutes)
        if (key == BgmKey.Other) return BgmKeyOut(BgmAction.None, false, m)
        if (repeat > 0 && key !in listOf(BgmKey.Left, BgmKey.Right)) return out()
        val closed = m.copy(open = false)
        val toggle = if (playing) BgmAction.Pause else BgmAction.Play
        return when (key) {
            BgmKey.PlayPause -> out(toggle)
            BgmKey.Play -> out(BgmAction.Play)
            BgmKey.Pause -> out(BgmAction.Pause)
            BgmKey.Next -> out(BgmAction.Next)
            BgmKey.Back -> if (m.open) out(state = closed) else out(BgmAction.Exit)
            BgmKey.Ok -> when {
                dimmed -> out()
                !m.open -> out(toggle)
                m.index < 4 -> out(BgmAction.TimerPick, closed, BgmTiming.PRESETS[m.index])
                m.index == 4 && timerActive -> out(BgmAction.TimerOff, closed)
                else -> out(state = closed)
            }
            BgmKey.Down -> if (dimmed || m.open) out() else out(state = BgmMenuState(true, if (timerActive) 4 else 1))
            BgmKey.Menu -> if (dimmed) out() else out(state = if (m.open) closed else BgmMenuState(true, if (timerActive) 4 else 1))
            BgmKey.Up -> out(state = closed)
            BgmKey.Left -> out(state = if (m.open) m.copy(index = (m.index - 1).coerceAtLeast(0)) else m)
            BgmKey.Right -> out(state = if (m.open) m.copy(index = (m.index + 1).coerceAtMost(if (timerActive) 4 else 3)) else m)
            BgmKey.Other -> error("handled")
        }
    }
}

class BgmPollPace {
    private var fast = 0
    var longPolling = true; private set
    fun note(took: Long, changed: Boolean) { if (changed || took >= 1000) fast = 0 else if (++fast >= 3) longPolling = false }
    fun gap(took: Long, failures: Int): Long = when {
        failures > 0 -> minOf(30_000L, 2000L shl failures.coerceIn(0, 4))
        !longPolling -> (5000 - took).coerceAtLeast(0)
        else -> (1000 - took).coerceAtLeast(0)
    }
}

object BgmChime {
    const val RATE = 22050
    fun samples(): ShortArray {
      val parts = listOf(Triple(659.25, 1.0, 1.9), Triple(1318.5, .35, 3.0), Triple(1819.53, .18, 4.6))
      return ShortArray((RATE * 2.2).toInt()) { i ->
        val t = i.toDouble() / RATE
        val attack = (t / .012).coerceAtMost(1.0)
        val release = ((2.2 - t) / .08).coerceIn(0.0, 1.0)
        val signal = parts.sumOf { (f, w, d) -> w * Math.exp(-d * t) * Math.sin(2 * Math.PI * f * t) }
        (signal / 1.53 * attack * release * .30 * Short.MAX_VALUE).toInt().toShort()
      }
    }
}
