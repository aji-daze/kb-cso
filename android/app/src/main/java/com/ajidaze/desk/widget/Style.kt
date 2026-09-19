package com.ajidaze.desk.widget

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/** ウィジェット共通の色と字。壁紙が透ける前提で、白と1色だけに絞る。 */
object W {
    val text = ColorProvider(Color(0xFFF3F3F5))
    val sub = ColorProvider(Color(0xA6F3F3F5))
    val faint = ColorProvider(Color(0x66F3F3F5))
    val accent = ColorProvider(Color(0xFFE0A458))

    val title = TextStyle(color = text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    val body = TextStyle(color = text, fontSize = 12.sp)
    val small = TextStyle(color = sub, fontSize = 10.5f.sp)
    val label = TextStyle(color = faint, fontSize = 10.sp, fontWeight = FontWeight.Medium)
    val big = TextStyle(color = text, fontSize = 34.sp, fontWeight = FontWeight.Normal)
    val time = TextStyle(color = sub, fontSize = 11.sp)
    val timeNow = TextStyle(color = accent, fontSize = 11.sp, fontWeight = FontWeight.Medium)
}
