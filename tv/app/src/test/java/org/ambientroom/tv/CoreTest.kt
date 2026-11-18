package org.ambientroom.tv

import org.junit.Assert.*
import org.junit.Test

internal fun fixture(name: String): String = checkNotNull(CoreTest::class.java.getResourceAsStream("/fixtures/$name")).bufferedReader().use { it.readText() }
internal fun snapshot(): Snapshot = BgmWire.state(fixture("snapshot.json"))

class CoreTest {
    @Test fun entryBaselinesCommandAndRestoresPause() {
        val s = snapshot().copy(paused = true, cmd = Command(17, "next"))
        val sync = BgmSync(); val u = sync.accept(s)!!
        assertNull(u.command); assertTrue(u.snapshot.paused); assertEquals(s.resume, u.snapshot.resume)
    }
    @Test fun repeatedCommandExecutesOnce() {
        val sync = BgmSync(); val s = snapshot(); sync.accept(s)
        assertEquals("next", sync.accept(s.copy(seq = s.seq + 1, cmd = Command(5, "next")))!!.command)
        assertNull(sync.accept(s.copy(seq = s.seq + 2, cmd = Command(5, "next")))!!.command)
    }
    @Test fun lowerRevisionCannotRewindOrExecute() {
        val sync = BgmSync(); val s = snapshot(); sync.accept(s)
        assertNull(sync.accept(s.copy(seq = s.seq - 1, cmd = Command(100, "next"))))
        assertEquals(s, sync.current)
    }
    @Test fun ownReplyAcknowledgesCommand() {
        val sync = BgmSync(); val s = snapshot(); sync.accept(s)
        val reply = s.copy(seq = s.seq + 1, cmd = Command(5, "next"))
        assertNull(sync.accept(reply, ownReply = true)!!.command)
        assertNull(sync.accept(reply)!!.command)
    }
    @Test fun gainRevisionAppliesWithoutSequenceChange() {
        val sync = BgmSync(); val s = snapshot(); sync.accept(s)
        val measured = s.copy(gainRev = 2, gains = listOf(Gain("track_1", -12.0)))
        assertTrue(sync.accept(measured)!!.gainsChanged)
        assertEquals(-12.0, sync.gains.single().gainDb!!, .0001)
        assertFalse(sync.accept(measured.copy(gainRev = 1))!!.gainsChanged)
        assertEquals(-12.0, sync.gains.single().gainDb!!, .0001)
    }
    @Test fun expiredMessageHidesEvenDuringOutage() {
        val tracker = MessageTracker(); val m = RoomMessage("Hello", "banner", 5000)
        tracker.update(m, 1000, 20)
        assertNotNull(tracker.current(4019)); assertNull(tracker.current(4020))
    }
    @Test fun delayedMessageReadCannotExtendLifetime() {
        val tracker = MessageTracker(); val m = RoomMessage("Hello", "card", 5000)
        tracker.update(m, 1000, 20); tracker.update(m, 1000, 2000)
        assertNull(tracker.current(4020))
    }
    @Test fun nullMessageClearsImmediately() {
        val tracker = MessageTracker(); tracker.update(RoomMessage("Hi", "card", 5000), 1000, 20)
        tracker.update(null, 1000, 20); assertNull(tracker.current(21))
    }
    @Test fun normalizationPreservesEmojiAndNonJoiner() {
        assertEquals("👩‍🍳", Greeting.clean("👩‍🍳")); assertEquals("a\u200cb", Greeting.clean("a\u200cb"))
        assertEquals("Café", Greeting.clean("Cafe\u0301"))
    }
    @Test fun resumeSequenceSurvivesNewInstanceAndSkippedSend() {
        var saved = 0L
        fun sequence() = ResumeSequence({ "session_demo" to saved }, { saved = it; true })
        assertEquals(1L, sequence().next("session_demo"))
        assertEquals(2L, sequence().next("session_demo"))
        // A reserved but unsent value stays consumed after process reconstruction.
        assertEquals(3L, sequence().next("session_demo"))
    }
    @Test fun wrongSessionAndFailedPersistenceCannotAllocateSample() {
        val sequence = ResumeSequence({ "session_demo" to 9L }, { false })
        for (session in listOf("old_session", "session_demo")) {
            try { sequence.next(session); fail("Expected refusal") } catch (_: IllegalStateException) { }
        }
    }
    @Test fun textLengthCountsCodePoints() {
        assertNotNull(Greeting.clean("😀".repeat(60))); assertNull(Greeting.clean("😀".repeat(61)))
    }
    private fun timer(end: Long = 1000, id: String = "one") = BgmTimerMachine().also { it.update(RoomTimer(id, end, 60), 0, 0, 0) }
    @Test fun timerHasTwoChimesThenRestores() {
        val t = timer(); assertTrue(t.step(999).isEmpty())
        assertEquals(listOf(TimerEvent.Chime(1)), t.step(2200)); assertEquals(.2f, t.volume(2200), .0001f)
        assertEquals(listOf(TimerEvent.Chime(2)), t.step(4600)); assertEquals(.2f, t.volume(6599), .0001f)
        assertTrue(t.volume(7800) in .2f..1f)
        assertEquals(listOf(TimerEvent.Finished("one", true)), t.step(9100)); assertEquals(1f, t.volume(9100), .0001f)
        assertTrue(t.step(9200).isEmpty())
    }
    @Test fun timerStaleFinishesSilently() {
        val t = timer(); assertEquals(listOf(TimerEvent.Finished("one", false)), t.step(21001)); assertEquals(1f, t.volume(21001), .0001f)
    }
    @Test fun timerUsesRequestSendMonotonicTime() {
        val t = BgmTimerMachine(); t.update(RoomTimer("one", 1_800_000_060_000, 60), 1_800_000_000_000, 100, 10100)
        assertEquals(50_000L, t.remaining(10100))
    }
    @Test fun sameTimerNeverMovesDeadlineLater() {
        val t = timer(); t.update(RoomTimer("one", 1000, 60), 0, 500, 500); assertEquals(1000L, t.deadline)
    }
    @Test fun completedTimerCannotBeResurrected() {
        val t = timer(); t.step(9100); t.update(RoomTimer("one", 999999, 60), 0, 0, 0); assertFalse(t.active())
    }
    @Test fun clearCountingTimerDoesNotRing() {
        val t = timer(); t.update(null, 0, 0, 100); assertTrue(t.step(10000).isEmpty()); assertEquals(1f, t.volume(10000), .0001f)
    }
    @Test fun offAfterDeadlineBeforeRingWasProcessedStaysSilent() {
        val t = timer(); t.update(null, 0, 0, 1100); assertTrue(t.step(2200).isEmpty()); assertFalse(t.active())
    }
    @Test fun clearDuringRingAllowsVolumeRestoration() {
        val t = timer(); t.step(2200); t.update(null, 0, 0, 2300)
        assertEquals(.2f, t.volume(2300), .0001f); assertEquals(listOf(TimerEvent.Chime(2)), t.step(4600))
        t.step(9100); assertEquals(1f, t.volume(9100), .0001f)
    }
    @Test fun replacementHasIndependentIdAndDeadline() {
        val t = timer(); t.step(2200); t.update(RoomTimer("two", 60000, 60), 0, 0, 2300)
        assertEquals("two", t.id); assertEquals(1f, t.volume(2300), .0001f)
        t.update(RoomTimer("one", 1000, 60), 0, 0, 2300); assertEquals("two", t.id)
    }
    @Test fun coarseStepDoesNotEmitOverlappingBells() {
        val t = timer(); assertEquals(listOf(TimerEvent.Chime(2)), t.step(5000)); assertTrue(t.step(5000).isEmpty())
    }
    @Test fun zeroVolumeAndPauseSurviveTimer() {
        val t = timer(); val s = snapshot().copy(paused = true, volume = 0)
        for (time in listOf(0L, 1000L, 2200L, 4600L, 9100L)) { t.step(time); assertEquals(0f, BgmVolume.mix(s.volume, t.volume(time), null), .0001f); assertTrue(s.paused) }
    }
    @Test fun gainAttenuatesWithoutAmplifying() {
        assertEquals(.25f, BgmVolume.mix(50, 1f, null), .0001f)
        assertEquals(.05f, BgmVolume.mix(50, .2f, null), .0001f)
        assertEquals(.25f, BgmVolume.mix(50, 1f, 20.0), .0001f)
        assertTrue(BgmVolume.mix(50, 1f, -6.0) < .13f)
    }
    @Test fun chimeIsBoundedAndClickFree() {
        val pcm = BgmChime.samples(); assertEquals(48510, pcm.size); assertEquals(0, pcm.first().toInt())
        assertTrue(pcm.maxOf { kotlin.math.abs(it.toInt()) } <= 9831); assertTrue(kotlin.math.abs(pcm.last().toInt()) < 20)
    }
    @Test fun queueEditsPreserveCurrentAndSuccessor() {
        val old = listOf("a", "b", "c"); val ops = BgmQueue.ops(old, listOf("a", "c"), "b", "c")
        assertEquals(listOf("a", "b", "c"), BgmQueue.apply(old, ops)); assertTrue(ops.isEmpty())
    }
    @Test fun queueUsesCoordinatorSuccessorAfterReorder() {
        val old = listOf("a", "b", "c"); assertEquals(listOf("b", "c", "a"), BgmQueue.apply(old, BgmQueue.ops(old, listOf("c", "a"), "b", "c")))
    }
    @Test fun emptyQueueIsSilent() {
        assertEquals(emptyList<String>(), BgmQueue.apply(listOf("a"), BgmQueue.ops(listOf("a"), emptyList(), "a")))
    }
    @Test fun queueMoveDoesNotRemoveCurrent() {
        val ops = BgmQueue.ops(listOf("a", "b", "c"), listOf("c", "a", "b"), "b")
        assertEquals(listOf(QueueOp.Move(2, 0)), ops)
    }
    @Test fun everySmallQueuePermutationReconciles() {
        fun perms(items: List<String>): List<List<String>> = if (items.isEmpty()) listOf(emptyList()) else items.flatMap { x -> perms(items - x).map { listOf(x) + it } }
        val old = listOf("a", "b", "c", "d")
        for (order in perms(old)) assertEquals(order, BgmQueue.apply(old, BgmQueue.ops(old, order, "c")))
    }
    @Test fun duplicatePlayerEntriesAreRemoved() {
        val old = listOf("a", "b", "a"); assertEquals(listOf("b", "a"), BgmQueue.apply(old, BgmQueue.ops(old, listOf("b", "a"), "b")))
    }
    @Test fun fallbackPollingAndBackoffAreBounded() {
        val p = BgmPollPace(); repeat(3) { p.note(30, false) }; assertFalse(p.longPolling)
        assertEquals(4970L, p.gap(30, 0)); assertEquals(30000L, p.gap(0, 40))
        assertEquals(970L, BgmPollPace().gap(30, 0))
    }
    @Test fun unknownSceneMapsToCalm() { assertEquals("calm", Scenes.id("unknown")); assertEquals("nightcity", Scenes.id("nightcity")) }
    @Test fun repeatedPhysicalToggleIsSuppressed() {
        for (key in listOf(BgmKey.Ok, BgmKey.PlayPause, BgmKey.Play, BgmKey.Pause, BgmKey.Next, BgmKey.Back, BgmKey.Menu)) {
            assertEquals(BgmAction.None, BgmKeys.reduce(key, 1, false, true, BgmMenuState(), true).action)
        }
    }
    @Test fun dimmedOkOnlyWakesButMediaKeyActs() {
        assertEquals(BgmAction.None, BgmKeys.reduce(BgmKey.Ok, 0, true, true, BgmMenuState(), true).action)
        assertEquals(BgmAction.Pause, BgmKeys.reduce(BgmKey.PlayPause, 0, true, true, BgmMenuState(), true).action)
    }
    @Test fun backClosesMenuBeforeExiting() {
        val first = BgmKeys.reduce(BgmKey.Back, 0, false, true, BgmMenuState(true, 2), true)
        assertFalse(first.menu.open); assertEquals(BgmAction.None, first.action)
        assertEquals(BgmAction.Exit, BgmKeys.reduce(BgmKey.Back, 0, false, true, first.menu, true).action)
    }
    @Test fun dpadPicksAllPresetsAndOff() {
        var menu = BgmKeys.reduce(BgmKey.Down, 0, false, true, BgmMenuState(), false).menu
        assertTrue(menu.open)
        menu = BgmKeys.reduce(BgmKey.Left, 0, false, true, menu, false).menu
        for (minutes in listOf(5, 15, 30, 60)) {
            assertEquals(minutes, BgmKeys.reduce(BgmKey.Ok, 0, false, true, menu, false).minutes)
            menu = BgmKeys.reduce(BgmKey.Right, 0, false, true, menu, false).menu
        }
        assertEquals(BgmAction.TimerOff, BgmKeys.reduce(BgmKey.Ok, 0, false, true, BgmMenuState(true, 4), true).action)
    }
    @Test fun staleOffSelectionCannotBecomeTimerPreset() {
        assertEquals(BgmAction.None, BgmKeys.reduce(BgmKey.Ok, 0, false, true, BgmMenuState(true, 4), false).action)
    }
    @Test fun systemVolumeKeysPassThrough() { assertFalse(BgmKeys.reduce(BgmKey.Other, 0, false, true, BgmMenuState(), false).consumed) }
}
