package app.hibiki;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HibikiNetPlugin.class);
        registerPlugin(HibikiBrowserPlugin.class);
        registerPlugin(HibikiFilesPlugin.class);
        registerPlugin(HibikiDbPlugin.class);
        registerPlugin(HibikiSecurePlugin.class);
        registerPlugin(HibikiDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor builds its own client and starts loading during super.onCreate(). Swap in ours
        // and load again, so every request from the first page on goes through it.
        bridge.setWebViewClient(new HibikiWebViewClient(bridge));
        bridge.reload();
    }
}
