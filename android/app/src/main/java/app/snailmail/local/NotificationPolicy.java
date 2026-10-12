package app.snailmail.local;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Pure policy shared by background delivery and JVM regression tests. */
final class NotificationPolicy {
    static final class Alert {
        final String key, slot, title, body, target, itemId;
        final boolean persistent;
        final Set<String> covers = new HashSet<>();

        Alert(JSONObject json) throws Exception {
            key = required(json, "key", 512);
            slot = required(json, "slot", 256);
            title = required(json, "title", 200);
            body = required(json, "body", 500);
            target = required(json, "target", 20);
            if (!target.equals("mail") && !target.equals("mailbox") && !target.equals("settings"))
                throw new IllegalArgumentException("Unknown notification destination");
            itemId = json.optString("itemId", "");
            if (itemId.length() > 256 || (target.equals("mail") && itemId.isEmpty()))
                throw new IllegalArgumentException("Invalid mail destination");
            persistent = json.getBoolean("persistent");
            JSONArray values = json.getJSONArray("covers");
            if (values.length() > 5) throw new IllegalArgumentException("Invalid receipt list");
            for (int i = 0; i < values.length(); i++) {
                String value = values.getString(i);
                if (value.isEmpty() || value.length() > 512) throw new IllegalArgumentException("Invalid receipt");
                covers.add(value);
            }
        }
    }

    static String required(JSONObject json, String key, int max) throws Exception {
        String value = json.getString(key);
        if (value.isEmpty() || value.length() > max) throw new IllegalArgumentException("Invalid " + key);
        return value;
    }

    static List<Alert> parse(String text) throws Exception {
        JSONObject feed = new JSONObject(text);
        if (feed.getInt("version") != 1) throw new IllegalArgumentException("Update the app to read this notification feed");
        required(feed, "generatedAt", 40);
        JSONArray values = feed.getJSONArray("alerts");
        if (values.length() > 5000) throw new IllegalArgumentException("Notification feed too large");
        List<Alert> alerts = new ArrayList<>();
        Set<String> keys = new HashSet<>(), slots = new HashSet<>();
        for (int i = 0; i < values.length(); i++) {
            Alert alert = new Alert(values.getJSONObject(i));
            if (!keys.add(alert.key) || !slots.add(alert.slot)) throw new IllegalArgumentException("Duplicate alert");
            alerts.add(alert);
        }
        return alerts;
    }

    static List<Alert> pending(List<Alert> alerts, Set<String> seen, Set<String> activeFailures, boolean initialized) {
        List<Alert> result = new ArrayList<>();
        if (initialized) for (Alert alert : alerts) {
            if (!(alert.persistent ? seen : activeFailures).contains(alert.key)) result.add(alert);
        }
        return result;
    }

    static void remember(Alert alert, Set<String> seen) {
        if (!alert.persistent) return;
        seen.add(alert.key);
        seen.addAll(alert.covers);
    }

    static Set<String> failures(List<Alert> alerts) {
        Set<String> result = new HashSet<>();
        for (Alert alert : alerts) if (!alert.persistent) result.add(alert.key);
        return result;
    }
}
