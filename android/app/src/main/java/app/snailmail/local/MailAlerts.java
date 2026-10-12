package app.snailmail.local;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;

// Enable/disable generations must be durable before queued workers can run.
@android.annotation.SuppressLint("ApplySharedPref")
final class MailAlerts {
    static final Object LOCK = new Object();
    static final String CHANNEL = "snail_mail_alerts";
    static final String PREFIX = "snail:";
    static final String PERIODIC = "snail-mail-background-check";
    static final String IMMEDIATE = "snail-mail-check-now";
    static final String TARGET = "snail_notification_target";
    static final String ITEM = "snail_notification_item";

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("mail-notifications", Context.MODE_PRIVATE);
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Mail alerts", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Important mail, approaching deadlines, mailbox fullness and check failures");
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    static boolean allowed(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(MailNotificationWorker.class, 12, TimeUnit.HOURS)
            .setConstraints(constraints).setInitialDelay(12, TimeUnit.HOURS).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work);
    }

    static void checkNow(Context context) {
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(MailNotificationWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build();
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.KEEP, work);
    }

    static void enable(Context context, boolean enabled) {
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(context);
            boolean changed = prefs.getBoolean("enabled", false) != enabled;
            SharedPreferences.Editor edit = prefs.edit().putBoolean("enabled", enabled);
            if (changed) edit.putLong("generation", prefs.getLong("generation", 0) + 1);
            if (enabled && changed) edit.putBoolean("initialized", false);
            edit.commit();
            if (enabled) {
                schedule(context);
                checkNow(context);
            } else {
                WorkManager.getInstance(context).cancelUniqueWork(PERIODIC);
                WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE);
                NotificationManagerCompat.from(context).cancelAll();
            }
        }
    }

    static Set<String> strings(SharedPreferences prefs, String key) {
        return new HashSet<>(prefs.getStringSet(key, new HashSet<>()));
    }

    static JSObject status(Context context) {
        SharedPreferences prefs = prefs(context);
        JSObject result = new JSObject();
        result.put("enabled", prefs.getBoolean("enabled", false));
        result.put("allowed", allowed(context));
        result.put("initialized", prefs.getBoolean("initialized", false));
        result.put("lastAttempt", prefs.getLong("lastAttempt", 0));
        result.put("lastSuccess", prefs.getLong("lastSuccess", 0));
        result.put("error", prefs.getString("error", ""));
        result.put("intervalHours", 12);
        return result;
    }

    static boolean show(Context context, String slot, String title, String body, String target, String itemId) {
        if (!allowed(context)) return false;
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            // Unique data makes PendingIntent identity independent of hash collisions.
            .setData(Uri.parse("snailmail://notification/" + Uri.encode(slot)))
            .putExtra(TARGET, target).putExtra(ITEM, itemId);
        PendingIntent pending = PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_mail_notification).setContentTitle(title).setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_REMINDER).setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(context).notify(PREFIX + slot, 0, builder.build());
            return true;
        } catch (SecurityException ignored) { return false; }
    }

    static void cancelInactive(Context context, Set<String> slots) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
            String tag = notification.getTag();
            if (tag != null && tag.startsWith(PREFIX) && !tag.equals(PREFIX + "test") &&
                !slots.contains(tag.substring(PREFIX.length()))) manager.cancel(tag, notification.getId());
        }
    }

    static void openSettings(Context context) {
        Intent intent = Build.VERSION.SDK_INT >= 26
            ? new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
}
