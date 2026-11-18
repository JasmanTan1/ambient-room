package org.ambientroom.tv

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Standalone TV entry point; pairing is the only route into a renderer session. */
class BgmActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val pairingWorker = Executors.newSingleThreadScheduledExecutor()
    private lateinit var store: RoomStore
    private var runtime: RoomRuntime? = null
    private var scene: BgmScene? = null
    private var firstControl: View? = null
    @Volatile private var active = false
    @Volatile private var pairingGeneration = 0
    private var pairingNetwork: RoomNetwork? = null
    private var pairingExpiry: Runnable? = null
    private var lastInput = 0L
    private var dimmed = false
    private var dimAfterMinutes = 10
    private val refresh = object : Runnable {
        override fun run() {
            if (!active) return
            dimmed = runtime != null && dimAfterMinutes > 0 && SystemClock.elapsedRealtime() - lastInput >= dimAfterMinutes * 60_000L
            window.attributes = window.attributes.apply { screenBrightness = if (dimmed) .02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
            scene?.invalidate()
            main.postDelayed(this, 1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = RoomStore(this)
        dimAfterMinutes = getPreferences(MODE_PRIVATE).getInt("dimMinutes", 10)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    override fun onStart() {
        super.onStart(); active = true; lastInput = SystemClock.elapsedRealtime()
        showCurrent(); main.post(refresh)
    }
    override fun onStop() {
        active = false; pairingGeneration++; pairingNetwork?.cancel(); pairingNetwork = null
        pairingExpiry?.let(main::removeCallbacks); pairingExpiry = null
        main.removeCallbacks(refresh)
        runtime?.close(); runtime = null; scene = null
        super.onStop()
    }
    override fun onDestroy() { pairingWorker.shutdownNow(); super.onDestroy() }
    private fun showCurrent() {
        val c = store.load()
        if (c == null) setup() else playing(c)
    }
    private fun column(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(48, 20, 48, 20); setBackgroundColor(0xff162b35.toInt())
    }
    private fun label(value: String, size: Float = 20f) = TextView(this).apply { text = value; textSize = size; setTextColor(-1) }
    private fun button(value: String, action: () -> Unit) = Button(this).apply { text = value; setOnClickListener { action() } }
    private fun setup(note: String = "") {
        pairingExpiry?.let(main::removeCallbacks); pairingExpiry = null
        pairingGeneration++; runtime?.close(sendStop = false); runtime = null; scene = null
        val box = column()
        box.addView(label("Ambient Room · Pair this TV", 28f))
        box.addView(label("Enter the coordinator origin, then approve the displayed code in its host remote. No address is preconfigured.", 17f))
        val origin = EditText(this).apply { hint = "Coordinator origin"; isSingleLine = true; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI }
        box.addView(origin)
        val allow = CheckBox(this).apply { text = "Allow insecure HTTP for my local coordinator"; setTextColor(-1) }
        box.addView(allow)
        val state = label(note, 17f); box.addView(state)
        val pair = button("Get pairing code") {}
        pair.setOnClickListener {
            val parsed = runCatching { CoordinatorOrigin.parse(origin.text.toString(), allow.isChecked) }.getOrNull()
            if (parsed == null) { state.text = "Enter an HTTP(S) origin without a path, credentials, query, or fragment. HTTPS is required unless HTTP is selected."; return@setOnClickListener }
            pair.isEnabled = false; origin.isEnabled = false; allow.isEnabled = false
            val generation = ++pairingGeneration
            val allowHttp = allow.isChecked
            val began = SystemClock.elapsedRealtime()
            val api = BgmApi(parsed, RoomNetwork(parsed) {}.also { pairingNetwork = it })
            state.text = "Requesting pairing code…"
            pairingWorker.execute {
                try {
                    val pending = api.beginPairing()
                    // PairStarted has no serverNow: use the maximum five-minute lifetime from send time.
                    // Pending/ready responses and the server remain the authority for early expiry.
                    val deadline = began + 5 * 60_000
                    main.post { if (active && pairingGeneration == generation) {
                        state.text = "Pairing code: ${pending.userCode}\nApprove it in the host remote within five minutes. This replaces any previously paired TV."
                        pairingExpiry = Runnable {
                            if (active && pairingGeneration == generation) {
                                pairingGeneration++; pairingNetwork?.cancel()
                                state.text = "Pairing expired. Request a new code."
                                pair.isEnabled = true; origin.isEnabled = true; allow.isEnabled = true
                            }
                        }.also { main.postDelayed(it, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0)) }
                    } }
                    claim(api, parsed, allowHttp, pending, deadline, generation, state) {
                        pair.isEnabled = true; origin.isEnabled = true; allow.isEnabled = true
                    }
                } catch (_: Exception) {
                    main.post { if (active && pairingGeneration == generation) { state.text = "Pairing could not start. Check the origin and coordinator setup."; pair.isEnabled = true; origin.isEnabled = true; allow.isEnabled = true } }
                }
            }
        }
        box.addView(pair)
        box.addView(label("Use the coordinator console to approve a host session first. The displayed code cannot claim a TV token by itself.", 15f))
        val scroll = ScrollView(this).apply { addView(box) }; setContentView(scroll); origin.requestFocus()
    }
    private fun claim(api: BgmApi, origin: CoordinatorOrigin, allowHttp: Boolean, pair: PairStarted, deadline: Long,
        generation: Int, label: TextView, reset: () -> Unit) {
        pairingWorker.schedule({
            if (!active || pairingGeneration != generation) return@schedule
            if (SystemClock.elapsedRealtime() >= deadline) {
                main.post { if (active && pairingGeneration == generation) { label.text = "Pairing expired. Request a new code."; reset() } }; return@schedule
            }
            var nextDelay = pair.pollAfterSec
            try {
                val result = api.claim(pair)
                if (result is PairResult.Ready) {
                    main.post {
                        if (active && pairingGeneration == generation && SystemClock.elapsedRealtime() < deadline) {
                            if (result.expiresAt <= result.snapshot.serverNow) { label.text = "Device token expired. Request a new code."; reset() }
                            else { store.save(origin, allowHttp, result); pairingGeneration++; playing(store.load()!!) }
                        }
                    }
                    return@schedule
                }
            } catch (e: Exception) {
                if (e is ApiFailure && e.status in listOf(400, 401, 403, 404, 410)) {
                    main.post { if (active && pairingGeneration == generation) { label.text = "Pairing expired or was refused. Request a new code."; reset() } }; return@schedule
                }
                nextDelay = maxOf(nextDelay, (e as? ApiFailure)?.retryAfterSec ?: 5)
            }
            claim(api, origin, allowHttp, pair.copy(pollAfterSec = nextDelay), deadline, generation, label, reset)
        }, pair.pollAfterSec.toLong(), TimeUnit.SECONDS)
    }
    private fun playing(credentials: DeviceCredentials) {
        pairingExpiry?.let(main::removeCallbacks); pairingExpiry = null
        val root = FrameLayout(this)
        val view = BgmScene(this).apply { id = View.generateViewId() }; scene = view
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun control(name: String, action: () -> Unit) = button(name, action).also { b ->
            b.nextFocusDownId = view.id; controls.addView(b, LinearLayout.LayoutParams(0, -2, 1f)); if (firstControl == null) firstControl = b
        }
        firstControl = null
        control("Playlists") {
            val lists = runtime?.sync?.current?.playlists.orEmpty()
            if (lists.isEmpty()) AlertDialog.Builder(this).setMessage("Link a playlist in the host remote, then return here.").setPositiveButton("OK", null).show()
            else AlertDialog.Builder(this).setTitle("Start playlist").setItems(lists.map { it.name }.toTypedArray()) { _, i -> runtime?.startPlaylist(lists[i].id); view.requestFocus() }.show()
        }
        control("Queue") {
            val tracks = runtime?.sync?.current?.queue?.tracks.orEmpty()
            AlertDialog.Builder(this).setTitle("Queue · edit and moderate in the host remote")
                .setMessage(if (tracks.isEmpty()) "Playlist order. Open the host remote to edit requests." else tracks.take(40).joinToString("\n") { it.title })
                .setPositiveButton("OK", null).show()
        }
        control("Scene") {
            AlertDialog.Builder(this).setTitle("Local scene").setItems((listOf("Follow room") + Scenes.ids).toTypedArray()) { _, i -> view.localScene = if (i == 0) null else Scenes.ids[i - 1]; view.invalidate() }.show()
        }
        control("Effects") {
            val options = arrayOf("Clear", "Rain", "Snow", "Sun", "Toggle decoration")
            AlertDialog.Builder(this).setTitle("Local effects").setItems(options) { _, i -> if (i == 4) view.decoration = !view.decoration else view.weather = options[i].lowercase(); view.invalidate() }.show()
        }
        control("Dim") {
            val minutes = listOf(0, 5, 10, 30)
            AlertDialog.Builder(this).setTitle("Dim after inactivity").setItems(arrayOf("Never", "5 minutes", "10 minutes", "30 minutes")) { _, i ->
                dimAfterMinutes = minutes[i]; getPreferences(MODE_PRIVATE).edit().putInt("dimMinutes", dimAfterMinutes).apply()
            }.show()
        }
        control("Disconnect") {
            AlertDialog.Builder(this).setMessage("Stop playback and clear this TV's pairing? Revoke the device in the host remote to invalidate its token and clear room photos.")
                .setNegativeButton("Cancel", null).setPositiveButton("Disconnect") { _, _ -> runtime?.close(); runtime = null; store.clear(); setup() }.show()
        }
        root.addView(controls, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        setContentView(root)
        val rt = RoomRuntime(this, credentials, store, { view.invalidate() }, { runtime = null; if (active) setup("Pairing expired or was revoked. Pair this TV again.") })
        runtime = rt; view.runtime = rt; rt.start(); view.requestFocus()
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val wasDimmed = dimmed
        if (event.action == KeyEvent.ACTION_DOWN) {
            lastInput = SystemClock.elapsedRealtime(); dimmed = false
            window.attributes = window.attributes.apply { screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
        }
        val view = scene
        val key = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> BgmKey.Ok
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> BgmKey.PlayPause
            KeyEvent.KEYCODE_MEDIA_PLAY -> BgmKey.Play
            KeyEvent.KEYCODE_MEDIA_PAUSE -> BgmKey.Pause
            KeyEvent.KEYCODE_MEDIA_NEXT -> BgmKey.Next
            KeyEvent.KEYCODE_BACK -> BgmKey.Back
            KeyEvent.KEYCODE_DPAD_LEFT -> BgmKey.Left
            KeyEvent.KEYCODE_DPAD_RIGHT -> BgmKey.Right
            KeyEvent.KEYCODE_DPAD_UP -> BgmKey.Up
            KeyEvent.KEYCODE_DPAD_DOWN -> BgmKey.Down
            KeyEvent.KEYCODE_MENU -> BgmKey.Menu
            else -> BgmKey.Other
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount > 0 && key in listOf(BgmKey.Ok, BgmKey.PlayPause, BgmKey.Play, BgmKey.Pause, BgmKey.Next, BgmKey.Menu, BgmKey.Back)) return true
        if (event.action == KeyEvent.ACTION_DOWN && wasDimmed && key in listOf(BgmKey.Ok, BgmKey.Left, BgmKey.Right, BgmKey.Up, BgmKey.Down, BgmKey.Menu)) {
            scene?.requestFocus(); return true
        }
        if (view != null && (view.hasFocus() || view.menu.open || key in listOf(BgmKey.PlayPause, BgmKey.Play, BgmKey.Pause, BgmKey.Next))) {
            if (event.action != KeyEvent.ACTION_DOWN) return if (key == BgmKey.Other) super.dispatchKeyEvent(event) else true
            if (key == BgmKey.Up && !view.menu.open && !wasDimmed) { firstControl?.requestFocus(); return true }
            val rt = runtime ?: return super.dispatchKeyEvent(event)
            val out = BgmKeys.reduce(key, event.repeatCount, wasDimmed, rt.media.player.playWhenReady, view.menu, rt.timer.active())
            view.menu = out.menu
            when (out.action) {
                BgmAction.Play -> if (rt.sync.current?.activePlaylistId == null) rt.startPlaylist(null) else rt.control("play")
                BgmAction.Pause -> rt.control("pause")
                BgmAction.Next -> rt.control("next")
                BgmAction.Exit -> finish()
                BgmAction.TimerPick -> rt.setTimer(out.minutes!!)
                BgmAction.TimerOff -> rt.clearTimer()
                BgmAction.None -> Unit
            }
            view.invalidate()
            if (out.consumed) return true
        }
        return super.dispatchKeyEvent(event)
    }
}
