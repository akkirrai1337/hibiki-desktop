package app.hibiki.poc;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HibikiNetPlugin.class);
        registerPlugin(HibikiBrowserPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor builds its own client and starts loading during super.onCreate(). Swap in ours
        // and load again, so index.html itself is served through it (it carries the COOP/COEP headers).
        bridge.setWebViewClient(new HibikiWebViewClient(bridge));
        bridge.reload();
    }
}
