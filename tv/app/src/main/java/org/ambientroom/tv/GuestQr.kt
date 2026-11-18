package org.ambientroom.tv

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

data class QrPixels(val width: Int, val height: Int, val pixels: IntArray)

/** Pure Java QR generation, shared by the Android view and offline decode tests. */
object GuestQr {
    fun pixels(url: String): QrPixels {
        require(url.length <= 512)
        val matrix = QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 400, 400,
            mapOf(EncodeHintType.MARGIN to 4, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.CHARACTER_SET to "UTF-8"))
        val pixels = IntArray(matrix.width * matrix.height) { i -> if (matrix[i % matrix.width, i / matrix.width]) 0xff000000.toInt() else 0xffffffff.toInt() }
        return QrPixels(matrix.width, matrix.height, pixels)
    }
}
