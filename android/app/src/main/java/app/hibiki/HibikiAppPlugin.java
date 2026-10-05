package app.hibiki;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The few things about the app's own window the mobile UI asks for: leaving to the launcher when
 * Back has nowhere left to go, keeping the screen on while a video plays, and turning the screen
 * for the player. The Back key itself arrives as a "hibikiback" window event (see MainActivity).
 */
@CapacitorPlugin(name = "HibikiApp")
public class HibikiAppPlugin extends Plugin {

    /** Back on the first screen: to the launcher, as other apps do, without destroying the activity. */
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("value", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /** Whether the player asked for the system bars out of the way - re-applied after anything that brings them back. */
    private boolean immersive = false;

    /**
     * The player's full screen: status and navigation bars hidden, a swipe from the edge shows them
     * for a moment and they hide again. Turning the screen (which the player itself asks for) and
     * coming back to the app both bring the bars back on some systems, so it is applied again then.
     */
    @PluginMethod
    public void setImmersive(PluginCall call) {
        immersive = Boolean.TRUE.equals(call.getBoolean("value", false));
        getActivity().runOnUiThread(this::applyImmersive);
        call.resolve();
    }

    private void applyImmersive() {
        Window window = getActivity().getWindow();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (immersive) {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        if (immersive) getActivity().getWindow().getDecorView().post(this::applyImmersive);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (immersive) getActivity().getWindow().getDecorView().post(this::applyImmersive);
    }

    /** "landscape" (either way up, following the sensor), "portrait", or "auto" for the user's own setting. */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String value = call.getString("value", "auto");
        int orientation;
        switch (value) {
            case "landscape":
                orientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
                break;
            case "portrait":
                orientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
                break;
            default:
                orientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        }
        getActivity().runOnUiThread(() -> getActivity().setRequestedOrientation(orientation));
        call.resolve();
    }
}
