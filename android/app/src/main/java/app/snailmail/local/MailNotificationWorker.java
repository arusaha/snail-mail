package app.snailmail.local;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;

// A finished worker must not leave delivery receipts pending an async disk write.
@android.annotation.SuppressLint("ApplySharedPref")
public class MailNotificationWorker extends Worker {
    public MailNotificationWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = MailAlerts.prefs(context);
        if (!prefs.getBoolean("enabled", false)) return Result.success();
        long generation = prefs.getLong("generation", 0);
        long started = System.currentTimeMillis();
        MailAlerts.createChannel(context);
        if (!MailAlerts.allowed(context)) return Result.success(); // Do not consume undeliverable alerts.
        try {
            List<NotificationPolicy.Alert> alerts = NotificationPolicy.parse(fetch());
            synchronized (MailAlerts.LOCK) {
                if (!current(prefs, generation, started)) return Result.success();
                Set<String> seen = MailAlerts.strings(prefs, "seen");
                Set<String> failures = MailAlerts.strings(prefs, "activeFailures");
                boolean initialized = prefs.getBoolean("initialized", false);
                Set<String> slots = new HashSet<>();
                for (NotificationPolicy.Alert alert : alerts) slots.add(alert.slot);
                MailAlerts.cancelInactive(context, slots);
                for (NotificationPolicy.Alert alert : NotificationPolicy.pending(alerts, seen, failures, initialized)) {
                    if (!MailAlerts.show(context, alert.slot, alert.title, alert.body, alert.target, alert.itemId)) return Result.success();
                    NotificationPolicy.remember(alert, seen);
                    if (!alert.persistent) failures.add(alert.key);
                    // Persist receipts only after Android accepted each notification.
                    prefs.edit().putStringSet("seen", new HashSet<>(seen)).putStringSet("activeFailures", new HashSet<>(failures)).commit();
                }
                if (!initialized) for (NotificationPolicy.Alert alert : alerts) NotificationPolicy.remember(alert, seen);
                prefs.edit().putStringSet("seen", seen).putStringSet("activeFailures", NotificationPolicy.failures(alerts))
                    .putBoolean("initialized", true).putLong("lastAttempt", started).putLong("lastSuccess", started)
                    .putLong("failureSince", 0).putBoolean("connectionAlerted", false).putString("error", "").commit();
            }
        } catch (Exception error) {
            synchronized (MailAlerts.LOCK) {
                if (!current(prefs, generation, started)) return Result.success();
                long since = prefs.getLong("failureSince", 0);
                if (since == 0) since = started;
                boolean alerted = prefs.getBoolean("connectionAlerted", false);
                if (!alerted && started - since >= 24 * 3600000L) {
                    alerted = MailAlerts.show(context, "connection", "Mail notifications cannot refresh",
                        "Connect Tailscale and check that your home server is awake.", "settings", "");
                }
                prefs.edit().putLong("lastAttempt", started).putLong("failureSince", since)
                    .putBoolean("connectionAlerted", alerted)
                    .putString("error", "Could not check mail. Connect Tailscale and check the home server; update the app if this continues.").commit();
            }
        }
        // Avoid frequent network retries when Tailscale or the home server is off.
        // The next scheduled or manual check retries without changing receipts.
        return Result.success();
    }

    private boolean current(SharedPreferences prefs, long generation, long started) {
        return !isStopped() && prefs.getBoolean("enabled", false) &&
            prefs.getLong("generation", 0) == generation && started >= prefs.getLong("lastAttempt", 0);
    }

    private String fetch() throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BuildConfig.MAIL_ORIGIN + "/api/notifications").openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Notification endpoint unavailable");
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase(java.util.Locale.ROOT).startsWith("application/json"))
                throw new IllegalStateException("Invalid notification response");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (isStopped() || output.size() + count > 1024 * 1024) throw new IllegalStateException("Notification response interrupted or too large");
                    output.write(buffer, 0, count);
                }
                return output.toString(StandardCharsets.UTF_8.name());
            }
        } finally { connection.disconnect(); }
    }
}
