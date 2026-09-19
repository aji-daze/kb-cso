package com.ajidaze.desk.widget

import android.content.Context
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.ImageProvider
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
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
import com.ajidaze.desk.MainActivity
import com.ajidaze.desk.R
import com.ajidaze.desk.Snapshot
import com.ajidaze.desk.SnapshotStore

/** 今日の集中。分数と連続日数だけ。押すとアプリが開く。 */
class FocusWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = SnapshotStore.load(context)
        val now = Snapshot.nowMinutes()
        val left = (snap.dayEnd - now).coerceAtLeast(0)

        provideContent {
            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(ImageProvider(R.drawable.widget_bg))
                    .padding(14.dp)
                    .clickable(actionStartActivity<MainActivity>())
            ) {
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("集中", style = W.label)
                    Spacer(modifier = GlanceModifier.defaultWeight())
                    if (snap.running) Text("進行中", style = W.timeNow)
                }
                Spacer(modifier = GlanceModifier.height(4.dp))
                Row(verticalAlignment = Alignment.Bottom) {
                    Text("${snap.focusMin}", style = W.big)
                    Spacer(modifier = GlanceModifier.width(4.dp))
                    Text("分", style = W.small)
                }
                Text(
                    "今日 ${snap.focusCount} 本 ・ 連続 ${snap.streak} 日",
                    style = W.small,
                    maxLines = 1,
                )
                Spacer(modifier = GlanceModifier.defaultWeight())
                Text(
                    if (left > 0) "終業まで ${left / 60}:${"%02d".format(left % 60)}" else "終業時刻を過ぎた",
                    style = W.small,
                    maxLines = 1,
                )
            }
        }
    }
}

class FocusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = FocusWidget()
}
