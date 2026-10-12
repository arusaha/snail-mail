package app.snailmail.local;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MailNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the full address-side scan zoomable without cropping it.
        getBridge().getWebView().getSettings().setSupportZoom(true);
        getBridge().getWebView().getSettings().setBuiltInZoomControls(true);
        getBridge().getWebView().getSettings().setDisplayZoomControls(false);
    }
}
