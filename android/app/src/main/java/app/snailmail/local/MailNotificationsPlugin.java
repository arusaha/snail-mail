package app.snailmail.local;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "MailNotifications", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
// Preserve pending notification taps before handing control to the WebView.
@android.annotation.SuppressLint("ApplySharedPref")
public class MailNotificationsPlugin extends Plugin {
    @Override public void load() {
        MailAlerts.createChannel(getContext());
        if (MailAlerts.prefs(getContext()).getBoolean("enabled", false)) MailAlerts.schedule(getContext());
        capture(getActivity().getIntent());
    }

    @PluginMethod public void getStatus(PluginCall call) { call.resolve(MailAlerts.status(getContext())); }

    @PluginMethod public void setEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (enabled && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionResult");
            return;
        }
        if (!enabled || MailAlerts.allowed(getContext())) MailAlerts.enable(getContext(), enabled);
        call.resolve(MailAlerts.status(getContext()));
    }

    @PermissionCallback private void permissionResult(PluginCall call) {
        if (MailAlerts.allowed(getContext())) MailAlerts.enable(getContext(), true);
        call.resolve(MailAlerts.status(getContext()));
    }

    @PluginMethod public void checkNow(PluginCall call) {
        if (!MailAlerts.prefs(getContext()).getBoolean("enabled", false)) { call.reject("Enable notifications first"); return; }
        MailAlerts.checkNow(getContext());
        call.resolve(MailAlerts.status(getContext()));
    }

    @PluginMethod public void testNotification(PluginCall call) {
        if (!MailAlerts.show(getContext(), "test", "Snail Mail notifications are ready",
            "This is a test. Tap to open notification settings.", "settings", "")) {
            call.reject("Allow Snail Mail notifications in Android settings first"); return;
        }
        call.resolve();
    }

    @PluginMethod public void openSettings(PluginCall call) { MailAlerts.openSettings(getContext()); call.resolve(); }

    private void capture(Intent intent) {
        if (intent == null || !intent.hasExtra(MailAlerts.TARGET)) return;
        String target = intent.getStringExtra(MailAlerts.TARGET);
        String item = intent.getStringExtra(MailAlerts.ITEM);
        intent.removeExtra(MailAlerts.TARGET);
        intent.removeExtra(MailAlerts.ITEM);
        if (!"mail".equals(target) && !"mailbox".equals(target) && !"settings".equals(target)) return;
        synchronized (MailAlerts.LOCK) {
            MailAlerts.prefs(getContext()).edit().putString("openTarget", target).putString("openItem", item == null ? "" : item).commit();
        }
        notifyListeners("notificationOpen", new JSObject(), true);
    }

    @Override protected void handleOnNewIntent(Intent intent) { capture(intent); }

    @PluginMethod public void consumeOpen(PluginCall call) {
        synchronized (MailAlerts.LOCK) {
            android.content.SharedPreferences prefs = MailAlerts.prefs(getContext());
            JSObject result = new JSObject();
            result.put("target", prefs.getString("openTarget", ""));
            result.put("itemId", prefs.getString("openItem", ""));
            prefs.edit().remove("openTarget").remove("openItem").commit();
            call.resolve(result);
        }
    }
}
