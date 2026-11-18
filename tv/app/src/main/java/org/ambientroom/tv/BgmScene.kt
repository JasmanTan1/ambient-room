package org.ambientroom.tv

import android.content.Context
import android.graphics.*
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.sin

/** Newly drawn geometry and system type; no inherited artwork, font, or photograph. */
class BgmScene(context: Context) : View(context) {
    var runtime: RoomRuntime? = null
    var menu = BgmMenuState()
    var localScene: String? = null
    var weather = "clear"
    var decoration = false
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var qrUrl: String? = null
    private var qrBitmap: Bitmap? = null
    private var confettiMessage: RoomMessage? = null
    private var confettiStarted = 0L
    init { isFocusable = true; isFocusableInTouchMode = true; contentDescription = "Music scene. OK plays or pauses. Down opens timer. Up opens controls." }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save(); canvas.scale(width / 640f, height / 360f)
        val time = LocalDateTime.now()
        val rt = runtime
        val state = rt?.sync?.current
        val scene = Scenes.id(localScene ?: state?.picture?.scene ?: state?.playlists?.firstOrNull { it.id == state.activePlaylistId }?.scene)
        val colors = when (scene) {
            "nightcity" -> intArrayOf(0xff10243e.toInt(), 0xff4a5185.toInt())
            "rain" -> intArrayOf(0xff163039.toInt(), 0xff397d83.toInt())
            "cafe" -> intArrayOf(0xff35281f.toInt(), 0xff9f7149.toInt())
            "festival" -> intArrayOf(0xff381d43.toInt(), 0xff9a4774.toInt())
            "kpop" -> intArrayOf(0xff2e204e.toInt(), 0xff4f8d9c.toInt())
            else -> intArrayOf(0xff173641.toInt(), 0xff5b8b7d.toInt())
        }
        paint.shader = LinearGradient(0f, 0f, 640f, 360f, colors, null, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, 640f, 360f, paint); paint.shader = null
        paint.color = 0x224de0bd
        for (i in 0..8) {
            val x = i * 88f - 30
            val top = 160 + (sin(i * 1.8) * 45).toFloat()
            canvas.drawRoundRect(x, top, x + 60, 360f, 8f, 8f, paint)
        }
        rt?.photo?.let { bitmap -> canvas.drawBitmap(bitmap, null, RectF(0f, 0f, 640f, 360f), paint) }
        paint.color = 0x73000000; canvas.drawRect(0f, 0f, 640f, 360f, paint)
        val now = RoomRuntime.now()
        if (weather == "rain" || weather == "snow") {
            paint.color = 0x66ffffff
            for (i in 0..60) {
                val x = ((i * 83) % 640).toFloat()
                val y = ((i * 47 + now / if (weather == "rain") 18 else 55) % 360).toFloat()
                if (weather == "rain") canvas.drawLine(x, y, x - 3, y + 9, paint) else canvas.drawCircle(x, y, 1.3f, paint)
            }
        }
        if (weather == "sun") { paint.color = 0x33fff0a0; canvas.drawCircle(560f, 65f, 40f, paint) }
        if (decoration) {
            paint.color = 0xffe6bd78.toInt()
            for (i in 0..7) canvas.drawCircle(320 + i * 40f, 20f + (i % 2) * 10, 5f, paint)
        }
        text(canvas, time.format(DateTimeFormatter.ofPattern("HH:mm")), 36f, 75f, 46f)
        text(canvas, time.format(DateTimeFormatter.ofPattern("EEEE, MMMM d")), 39f, 101f, 14f)
        if (rt?.timer?.active() == true) {
            val seconds = (rt.timer.remaining(now) + 999) / 1000
            text(canvas, if (seconds == 0L) "Chime" else "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}", 250f, 70f, 22f)
        }
        rt?.media?.track()?.let { text(canvas, it.title.take(48), 38f, 260f, 18f); text(canvas, it.artist.take(60), 38f, 282f, 12f) }
        val message = rt?.banner?.current(now)
        if (message != null) {
            if (message != confettiMessage) { confettiMessage = message; confettiStarted = now }
            if (message.style == "card") { paint.color = 0x99203038.toInt(); canvas.drawRoundRect(30f, 122f, 438f, 218f, 12f, 12f, paint) }
            paragraph(canvas, message.text, 40f, 139f, 390, if (message.style == "card") 24f else 21f)
            if (message.style == "confetti" && now - confettiStarted < 5000) {
                for (i in 0..59) {
                    paint.color = intArrayOf(0xffeeb56d.toInt(), 0xffa3e0d1.toInt(), 0xffdf9fce.toInt())[i % 3]
                    val x = (i * 73 % 430).toFloat()
                    val y = ((i * 29 + (now - confettiStarted) / 18) % 230).toFloat()
                    canvas.drawRect(x, y, x + 3, y + 5, paint)
                }
            }
        }
        val url = rt?.qr?.current(now)
        if (url != qrUrl) {
            qrUrl = url
            qrBitmap = url?.let { link -> runCatching { qr(link) }.getOrNull() }
        }
        qrBitmap?.takeIf { url != null && rt?.qr?.current(RoomRuntime.now()) == url }?.let {
            paint.color = Color.WHITE; canvas.drawRoundRect(505f, 206f, 613f, 314f, 4f, 4f, paint)
            paint.isFilterBitmap = false; canvas.drawBitmap(it, null, RectF(509f, 210f, 609f, 310f), paint)
            text(canvas, "Add a song", 524f, 329f, 12f)
        }
        if (menu.open) {
            paint.color = 0xee142831.toInt(); canvas.drawRoundRect(30f, 222f, 467f, 302f, 8f, 8f, paint)
            text(canvas, "Timer", 44f, 244f, 14f)
            val options = BgmTiming.PRESETS.map { "$it min" } + if (rt?.timer?.active() == true) listOf("Off") else emptyList()
            options.forEachIndexed { index, label ->
                val x = 44 + index * 80f
                if (menu.index == index) { paint.color = 0xff426b6f.toInt(); canvas.drawRoundRect(x - 5, 256f, x + 66, 287f, 5f, 5f, paint) }
                text(canvas, label, x, 277f, 14f)
            }
        }
        val status = rt?.status.orEmpty()
        if (status.isNotEmpty()) paragraph(canvas, status, 38f, 304f, 410, 13f)
        if (state?.paused == true) text(canvas, "Paused", 38f, 232f, 14f)
        if (time.hour >= 23 || time.hour < 7) { paint.color = 0x44000000; canvas.drawRect(0f, 0f, 640f, 360f, paint) }
        if (hasFocus()) { paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f; paint.color = 0x88b5dfd1.toInt(); canvas.drawRect(2f, 2f, 638f, 358f, paint); paint.style = Paint.Style.FILL }
        canvas.restore()
    }
    private fun text(canvas: Canvas, text: String, x: Float, y: Float, size: Float) {
        paint.color = Color.WHITE; paint.textSize = size; paint.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        canvas.drawText(text, x, y, paint)
    }
    private fun paragraph(canvas: Canvas, text: String, x: Float, y: Float, width: Int, size: Float) {
        val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = size }
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, tp, width).setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(3).build()
        canvas.save(); canvas.translate(x, y); layout.draw(canvas); canvas.restore()
    }
    companion object {
        fun qr(url: String): Bitmap {
            val image = GuestQr.pixels(url)
            return Bitmap.createBitmap(image.pixels, image.width, image.height, Bitmap.Config.ARGB_8888)
        }
    }
}
