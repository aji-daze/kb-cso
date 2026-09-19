package com.ajidaze.desk

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.ajidaze.desk.widget.FocusWidget
import com.ajidaze.desk.widget.TasksWidget
import com.ajidaze.desk.widget.TimelineWidget

/**
 * 15分おきにウィジェットを描き直す。中身が変わらなくても、
 * 「いま」「残り」の表示は時間とともにずれるため。
 */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        updateWidgets(applicationContext)
        return Result.success()
    }

    companion object {
        suspend fun updateWidgets(context: Context) {
            TimelineWidget().updateAll(context)
            TasksWidget().updateAll(context)
            FocusWidget().updateAll(context)
        }
    }
}
