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
import com.ajidaze.desk.MainActivity
import com.ajidaze.desk.R
import com.ajidaze.desk.SnapshotStore
import com.ajidaze.desk.Task

/** やること。ConTodo のタスクは「次の一歩」も添える。 */
class TasksWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snap = SnapshotStore.load(context)
        provideContent {
            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(ImageProvider(R.drawable.widget_bg))
                    .padding(14.dp)
                    .clickable(actionStartActivity<MainActivity>())
            ) {
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("やること", style = W.label)
                    Spacer(modifier = GlanceModifier.defaultWeight())
                    Text("${snap.remain}", style = W.label)
                }
                Spacer(modifier = GlanceModifier.height(8.dp))

                if (snap.tasks.isEmpty()) {
                    Text(
                        if (snap.isEmpty) "アプリを一度開くと、ここに出る。" else "残っているタスクはない。",
                        style = W.small,
                        maxLines = 2,
                    )
                } else {
                    snap.tasks.take(5).forEach { t -> Line(t) }
                }
            }
        }
    }

    @Composable
    private fun Line(t: Task) {
        Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("○", style = W.time)
                Spacer(modifier = GlanceModifier.width(7.dp))
                Text(t.text, style = W.body, maxLines = 1)
            }
            if (t.step.isNotBlank()) {
                Row {
                    Spacer(modifier = GlanceModifier.width(19.dp))
                    Text("→ ${t.step}", style = W.small, maxLines = 1)
                }
            }
        }
    }
}

class TasksWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TasksWidget()
}
