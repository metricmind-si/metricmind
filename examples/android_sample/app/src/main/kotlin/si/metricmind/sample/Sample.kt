// MetricMind native Android sample. Each button can also be triggered from adb so a
// test can drive the real app:  adb shell am start -n si.metricmind.sample/.MainActivity --es action crash
package si.metricmind.sample

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import si.metricmind.MetricMind

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        MetricMind.init(this, site = "site_example", endpoint = "http://10.0.2.2:3200/v1/batch")
    }
}

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun button(label: String, action: String) = layout.addView(Button(this).apply { text = label; setOnClickListener { run(action) } })
        button("Open a listing", "listing")
        button("Publish", "event")
        button("Contact on WhatsApp", "contact")
        button("Report a handled error", "error")
        button("Crash the app", "crash")
        button("Freeze (ANR)", "anr")
        setContentView(layout)
        intent.getStringExtra("action")?.let(::run)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let(MetricMind::openUrl)
        intent.getStringExtra("action")?.let(::run)
    }

    private fun run(action: String) {
        when (action) {
            "listing" -> startActivity(Intent(this, ListingActivity::class.java))
            "event" -> MetricMind.track("listing_published", mapOf("category" to "cars"))
            "contact" -> MetricMind.contact("WhatsApp")
            "error" -> MetricMind.captureError(IllegalStateException("price is missing"))
            "crash" -> throw NullPointerException("Attempt to read price on a null listing")
            "close" -> finish() // the process stays alive: the next launch is a warm start
            "anr" -> Thread.sleep(60_000) // blocks the main thread until Android reports "app isn't responding"
        }
    }
}

class ListingActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(LinearLayout(this))
        // Pretend the listing's data takes 800 ms to arrive, then report the screen fully displayed.
        window.decorView.postDelayed({ MetricMind.screenReady() }, 800)
    }
}
