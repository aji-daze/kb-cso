package com.ajidaze.wataamemo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Map;

/**
 * 通知欄に固定したメモ。画面（WataaApp.notify）から題名と本文を受け取って、消えない通知を出す。
 * 中身はここにも覚えておき、端末の再起動のあと（BOOT_COMPLETED）に出し直す。
 */
public class Pins extends BroadcastReceiver {

    static final String CH = "pinned";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("pins", Context.MODE_PRIVATE); }

    static int nid(String id) { return 1000 + (id.hashCode() & 0x7ffffff); }

    static void put(Context c, String id, String title, String text) {
        prefs(c).edit().putString("t:" + id, title).putString("x:" + id, text).apply();
        show(c, id, title, text);
    }

    static void remove(Context c, String id) {
        prefs(c).edit().remove("t:" + id).remove("x:" + id).apply();
        nm(c).cancel(nid(id));
    }

    static void showAll(Context c) {
        SharedPreferences p = prefs(c);
        for (Map.Entry<String, ?> e : p.getAll().entrySet()) {
            if (!e.getKey().startsWith("t:")) continue;
            String id = e.getKey().substring(2);
            show(c, id, String.valueOf(e.getValue()), p.getString("x:" + id, ""));
        }
    }

    static NotificationManager nm(Context c) { return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE); }

    static void show(Context c, String id, String title, String text) {
        NotificationManager m = nm(c);
        if (m.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "固定したメモ", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            m.createNotificationChannel(ch);
        }
        // 押すとそのメモを開く
        Intent open = new Intent(c, MainActivity.class).setAction("open:" + id).putExtra("open", id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, nid(id), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(c, CH)
                .setSmallIcon(R.drawable.ic_note)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        try { m.notify(nid(id), b.build()); } catch (SecurityException ignored) { }   // 通知が許可されていない
    }

    // 再起動のあとに出し直す
    @Override
    public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction()) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) showAll(c);
    }
}
