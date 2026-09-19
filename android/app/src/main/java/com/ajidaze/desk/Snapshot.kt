package com.ajidaze.desk

import org.json.JSONObject
import java.util.Calendar

/**
 * Web 側（DESK の画面）が渡してくる、その日ぶんの要約。
 * ウィジェットはこれだけを見て描く。
 */
data class Block(
    val title: String,
    val start: Int,   // 0:00 からの分
    val end: Int,
    val kind: String, // work / focus / meet / rest
    val src: String,  // desk / contodo
)

data class Task(
    val text: String,
    val step: String,
    val src: String,
)

data class Snapshot(
    val at: Long = 0L,
    val dayStart: Int = 9 * 60,
    val dayEnd: Int = 18 * 60,
    val blocks: List<Block> = emptyList(),
    val tasks: List<Task> = emptyList(),
    val focusMin: Int = 0,
    val focusCount: Int = 0,
    val streak: Int = 0,
    val running: Boolean = false,
) {
    /** いま進んでいるブロック */
    fun current(nowMin: Int): Block? = blocks.firstOrNull { nowMin in it.start until it.end }

    /** これから始まるブロック */
    fun upcoming(nowMin: Int): List<Block> = blocks.filter { it.start > nowMin }.sortedBy { it.start }

    val isEmpty: Boolean get() = at == 0L

    companion object {
        fun nowMinutes(): Int {
            val c = Calendar.getInstance()
            return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        }

        fun hhmm(min: Int): String {
            val h = (min / 60) % 24
            val m = min % 60
            return "%02d:%02d".format(h, m)
        }

        private fun toMin(hm: String?): Int {
            if (hm.isNullOrBlank()) return 0
            val p = hm.split(":")
            val h = p.getOrNull(0)?.toIntOrNull() ?: 0
            val m = p.getOrNull(1)?.toIntOrNull() ?: 0
            return h * 60 + m
        }

        /** 壊れた JSON が来ても落ちないように、読めたところまでで返す。 */
        fun parse(json: String?): Snapshot {
            if (json.isNullOrBlank()) return Snapshot()
            return try {
                val o = JSONObject(json)
                val blocks = mutableListOf<Block>()
                o.optJSONArray("blocks")?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val b = arr.optJSONObject(i) ?: continue
                        blocks.add(
                            Block(
                                title = b.optString("title", "（無題）"),
                                start = toMin(b.optString("start")),
                                end = toMin(b.optString("end")),
                                kind = b.optString("kind", "work"),
                                src = b.optString("src", "desk"),
                            )
                        )
                    }
                }
                val tasks = mutableListOf<Task>()
                o.optJSONArray("tasks")?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val t = arr.optJSONObject(i) ?: continue
                        tasks.add(
                            Task(
                                text = t.optString("text", ""),
                                step = t.optString("step", ""),
                                src = t.optString("src", "desk"),
                            )
                        )
                    }
                }
                val focus = o.optJSONObject("focus")
                Snapshot(
                    at = o.optLong("at", 0L),
                    dayStart = toMin(o.optString("dayStart", "09:00")),
                    dayEnd = toMin(o.optString("dayEnd", "18:00")),
                    blocks = blocks.sortedBy { it.start },
                    tasks = tasks,
                    focusMin = focus?.optInt("min", 0) ?: 0,
                    focusCount = focus?.optInt("count", 0) ?: 0,
                    streak = focus?.optInt("streak", 0) ?: 0,
                    running = o.optBoolean("running", false),
                )
            } catch (e: Exception) {
                Snapshot()
            }
        }
    }
}
