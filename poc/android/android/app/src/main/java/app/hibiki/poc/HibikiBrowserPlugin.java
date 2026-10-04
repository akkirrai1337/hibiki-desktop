package app.hibiki.poc;

import android.annotation.SuppressLint;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Hidden WebViews for challenge pages (and later browserFetch / BROWSER resolvers / web login) -
 * the counterpart of desktop's hidden BrowserWindows. Each one sits behind the app's WebView at
 * full size rather than being made invisible, so the page keeps running timers and animation
 * frames exactly as it would on screen.
 */
@CapacitorPlugin(name = "HibikiBrowser")
public class HibikiBrowserPlugin extends Plugin {

    private final Map<String, WebView> views = new HashMap<>();

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void open(PluginCall call) {
        String key = call.getString("key");
        String url = call.getString("url");
        JSObject headersObject = call.getObject("headers", new JSObject());
        boolean clearOrigin = call.getBoolean("clearOrigin", false);
        getActivity().runOnUiThread(() -> {
            try {
                WebView existing = views.remove(key);
                if (existing != null) destroy(existing);

                CookieManager cookies = CookieManager.getInstance();
                if (clearOrigin) expireCookies(cookies, url);

                WebView view = new WebView(getContext());
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setMediaPlaybackRequiresUserGesture(true);
                cookies.setAcceptCookie(true);
                cookies.setAcceptThirdPartyCookies(view, true);
                view.setWebViewClient(new WebViewClient());

                ViewGroup parent = (ViewGroup) bridge.getWebView().getParent();
                parent.addView(view, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                views.put(key, view);

                Map<String, String> headers = new HashMap<>();
                Iterator<String> names = headersObject.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    headers.put(name, headersObject.optString(name));
                }
                view.loadUrl(url, headers);
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e), e);
            }
        });
    }

    @PluginMethod
    public void eval(PluginCall call) {
        String key = call.getString("key");
        String js = call.getString("js", "undefined");
        getActivity().runOnUiThread(() -> {
            WebView view = views.get(key);
            if (view == null) {
                call.reject("no hidden page " + key);
                return;
            }
            view.evaluateJavascript(js, value -> {
                JSObject result = new JSObject();
                result.put("value", value);
                call.resolve(result);
            });
        });
    }

    @PluginMethod
    public void cookies(PluginCall call) {
        String value = CookieManager.getInstance().getCookie(call.getString("url"));
        JSObject result = new JSObject();
        result.put("value", value == null ? "" : value);
        call.resolve(result);
    }

    @PluginMethod
    public void userAgent(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", WebSettings.getDefaultUserAgent(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void close(PluginCall call) {
        String key = call.getString("key");
        getActivity().runOnUiThread(() -> {
            WebView view = views.remove(key);
            if (view != null) destroy(view);
            call.resolve();
        });
    }

    private static void destroy(WebView view) {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.stopLoading();
        view.destroy();
    }

    /** CookieManager has no per-origin clear; expire each cookie the URL currently sees instead. */
    private static void expireCookies(CookieManager cookies, String url) {
        String current = cookies.getCookie(url);
        if (current == null) return;
        for (String part : current.split(";")) {
            int index = part.indexOf('=');
            if (index <= 0) continue;
            cookies.setCookie(url, part.substring(0, index).trim() + "=; Max-Age=0");
        }
        cookies.flush();
    }
}
