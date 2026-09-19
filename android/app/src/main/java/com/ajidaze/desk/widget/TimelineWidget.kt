package com.ajidaze.desk.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.ImageProvider
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.Text
import com.ajidaze.desk.Block
import com.ajidaze.desk.MainActivity
import com.ajidaze.desk.R
import com.ajidaze.desk.Snapshot
import com.ajidaze.desk.SnapshotStore

/** 今日の流れ。いま進んでいるものと、次に来るものを出す。 */
class TimelineWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = SnapshotStore.load(context)
        provideContent { Content(snap) }
    }

    @Composable
    private fun Content(snap: Snapshot) {
        val now = Snapshot.nowMinutes()
        val cur = snap.current(now)
        val next = snap.upcoming(now)

        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(ImageProvider(R.drawable.widget_bg))
                .padding(14.dp)
                .clickable(actionStartActivity<MainActivity>())
        ) {
            Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("今日の流れ", style = W.label)
                Spacer(modifier = GlanceModifier.defaultWeight())
                Text(Snapshot.hhmm(now), style = W.label)
            }
            Spacer(modifier = GlanceModifier.height(8.dp))

            if (snap.isEmpty) {
                Text("アプリを一度開くと、ここに今日の予定が出る。", style = W.small, maxLines = 2)
                return@Column
            }

            if (cur != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("●", style = W.timeNow)
                    Spacer(modifier = GlanceModifier.width(6.dp))
                    Text(cur.title, style = W.title, maxLines = 1)
                }
                Text(
                    "${Snapshot.hhmm(cur.start)}–${Snapshot.hhmm(cur.end)} ・ 残り ${cur.end - now} 分",
                    style = W.small,
                    maxLines = 1,
                )
                Spacer(modifier = GlanceModifier.height(8.dp))
            } else {
                Text("いまは予定なし", style = W.small, maxLines = 1)
                Spacer(modifier = GlanceModifier.height(6.dp))
            }

            next.take(3).forEach { b -> Line(b) }

            if (cur == null && next.isEmpty()) {
                Text("この先の予定もなし", style = W.small, maxLines = 1)
            }

            Spacer(modifier = GlanceModifier.defaultWeight())
            Text(
                "集中 ${snap.focusMin} 分 ・ 残タスク ${snap.remain}",
                style = W.small,
                maxLines = 1,
            )
        }
    }

    @Composable
    private fun Line(b: Block) {
        Row(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 3.dp)) {
            Text(Snapshot.hhmm(b.start), style = W.time)
            Spacer(modifier = GlanceModifier.width(8.dp))
            Text(b.title, style = W.body, maxLines = 1)
        }
    }
}

class TimelineWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TimelineWidget()
}
