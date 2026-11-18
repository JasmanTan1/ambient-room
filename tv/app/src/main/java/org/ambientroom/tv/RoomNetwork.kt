package org.ambientroom.tv

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class RoomNetwork(private val origin: CoordinatorOrigin, private val onUnauthorized: () -> Unit) : Transport {
    val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            if (!origin.sameOrigin(chain.request().url.toString())) throw IOException("Unexpected destination")
            val response = chain.proceed(chain.request())
            if (response.code == 401) onUnauthorized()
            response
        }.build()
    override fun send(request: ApiRequest): ApiResponse {
        require(origin.sameOrigin(request.url))
        val builder = Request.Builder().url(request.url)
        request.headers.forEach { (key, value) -> builder.header(key, value) }
        val body = request.body?.toRequestBody("application/json".toMediaType())
            ?: if (request.method in listOf("POST", "PUT")) ByteArray(0).toRequestBody(null) else null
        builder.method(request.method, body)
        val callClient = client.newBuilder().readTimeout(request.timeoutSec.toLong(), TimeUnit.SECONDS)
            .callTimeout((request.timeoutSec + 10).toLong(), TimeUnit.SECONDS).build()
        return callClient.newCall(builder.build()).execute().use { response ->
            val retry = response.header("Retry-After")?.toIntOrNull()?.coerceIn(1, 3600)
            // Error bodies can contain deployment details; discard them without parsing or logging.
            val text = if (response.code == 200) {
                val source = response.body?.source() ?: throw IOException("Empty response")
                source.request(JSON_LIMIT + 1)
                if (source.buffer.size > JSON_LIMIT) throw IOException("Response too large")
                source.readUtf8()
            } else ""
            ApiResponse(response.code, text, retry)
        }
    }
    fun cancel() { client.dispatcher.cancelAll() }
    companion object { private const val JSON_LIMIT = 16L * 1024 * 1024 }
}
