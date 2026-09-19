package com.ajidaze.desk

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

/**
 * WebView から受け取った要約を1件だけ持つ。
 * ウィジェットは端末が眠っていても読めるよう、ここ（DataStore）から取る。
 */
private val Context.store by preferencesDataStore(name = "desk_snapshot")

object SnapshotStore {
    private val KEY = stringPreferencesKey("snapshot_json")

    suspend fun save(context: Context, json: String) {
        context.store.edit { it[KEY] = json }
    }

    suspend fun load(context: Context): Snapshot {
        val prefs = context.store.data.first()
        return Snapshot.parse(prefs[KEY])
    }
}
