package app.snailmail.local;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import static org.junit.Assert.*;

public class NotificationPolicyTest {
    private JSONObject alert(String key, boolean persistent) throws Exception {
        return new JSONObject().put("key", key).put("slot", "mail:a:1")
            .put("title", "Important mail").put("body", "Open the app")
            .put("target", "mail").put("itemId", "a:1").put("persistent", persistent)
            .put("covers", new JSONArray());
    }
    private String feed(JSONObject... alerts) throws Exception {
        JSONArray values = new JSONArray();
        for (JSONObject value : alerts) values.put(value);
        return new JSONObject().put("version", 1).put("generatedAt", "2026-10-12T01:00:00Z").put("alerts", values).toString();
    }
    @Test public void firstCheckIsQuietAndRepeatedChecksStayQuiet() throws Exception {
        List<NotificationPolicy.Alert> snapshot = NotificationPolicy.parse(feed(alert("mail:a:1:important", true)));
        Set<String> seen = new HashSet<>();
        assertTrue(NotificationPolicy.pending(snapshot, seen, new HashSet<>(), false).isEmpty());
        NotificationPolicy.remember(snapshot.get(0), seen);
        assertTrue(NotificationPolicy.pending(snapshot, new HashSet<>(seen), new HashSet<>(), true).isEmpty());
        List<NotificationPolicy.Alert> added = NotificationPolicy.parse(feed(alert("mail:b:1:important", true)));
        assertEquals(1, NotificationPolicy.pending(added, seen, new HashSet<>(), true).size());
    }
    @Test public void escalationNotifiesButDowngradeAndUndoDoNot() throws Exception {
        Set<String> seen = new HashSet<>();
        NotificationPolicy.Alert high = NotificationPolicy.parse(feed(alert("mail:a:1:urgent", true)
            .put("covers", new JSONArray().put("mail:a:1:important")))).get(0);
        assertEquals(1, NotificationPolicy.pending(java.util.Collections.singletonList(high), seen, new HashSet<>(), true).size());
        NotificationPolicy.remember(high, seen);
        List<NotificationPolicy.Alert> lower = NotificationPolicy.parse(feed(alert("mail:a:1:important", true)));
        assertTrue(NotificationPolicy.pending(lower, seen, new HashSet<>(), true).isEmpty());
        assertTrue(NotificationPolicy.pending(new ArrayList<>(), seen, new HashSet<>(), true).isEmpty());
        assertTrue(NotificationPolicy.pending(java.util.Collections.singletonList(high), seen, new HashSet<>(), true).isEmpty());
    }
    @Test public void aFailureWarnsOnceAndCanWarnAgainAfterRecovery() throws Exception {
        List<NotificationPolicy.Alert> failure = NotificationPolicy.parse(feed(alert("sync-failed:abc", false)));
        Set<String> seen = new HashSet<>();
        assertEquals(1, NotificationPolicy.pending(failure, seen, new HashSet<>(), true).size());
        assertTrue(NotificationPolicy.pending(failure, seen, NotificationPolicy.failures(failure), true).isEmpty());
        assertEquals(1, NotificationPolicy.pending(failure, seen, NotificationPolicy.failures(new ArrayList<>()), true).size());
    }
    @Test public void malformedOrIncompleteSnapshotsCannotAdvanceReceipts() throws Exception {
        assertThrows(Exception.class, () -> NotificationPolicy.parse("{}"));
        assertThrows(Exception.class, () -> NotificationPolicy.parse(feed(alert("a", true), alert("a", true))));
        assertThrows(Exception.class, () -> NotificationPolicy.parse(feed(alert("a", true).put("target", "https://evil.example"))));
        assertThrows(Exception.class, () -> NotificationPolicy.parse(feed(alert("a", true).put("itemId", ""))));
        assertThrows(Exception.class, () -> NotificationPolicy.parse(new JSONObject(feed()).put("version", 2).toString()));
    }
}
