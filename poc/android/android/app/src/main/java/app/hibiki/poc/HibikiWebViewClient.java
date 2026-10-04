package app.hibiki.poc;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

/**
 * Three jobs on top of Capacitor's client:
 *  - adds COOP/COEP to the app's own responses, so the page is crossOriginIsolated and can use SharedArrayBuffer;
 *  - serves /_hibiki/stream (the header-injecting stream proxy for the player);
 *  - serves /_hibiki/bridge/&lt;id&gt; (the synchronous-XHR fallback transport for extension workers).
 * Runs on WebView's IO threads, so blocking here (network, waiting on the bridge) is allowed.
 */
public class HibikiWebViewClient extends BridgeWebViewClient {

    private final Bridge bridge;

    public HibikiWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        boolean local = bridge.getHost().equals(url.getHost());
        String path = url.getPath() == null ? "" : url.getPath();
        if (local && path.startsWith("/_hibiki/stream")) return StreamProxy.handle(request);
        if (local && path.startsWith("/_hibiki/bridge/")) return BridgeQueue.await(path.substring("/_hibiki/bridge/".length()));

        WebResourceResponse response = super.shouldInterceptRequest(view, request);
        if (response != null && local) {
            Map<String, String> headers = new HashMap<>();
            if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
            headers.put("Cross-Origin-Opener-Policy", "same-origin");
            headers.put("Cross-Origin-Embedder-Policy", "credentialless");
            response.setResponseHeaders(headers);
        }
        return response;
    }
}
