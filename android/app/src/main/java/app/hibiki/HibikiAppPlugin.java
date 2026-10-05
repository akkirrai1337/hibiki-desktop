package app.hibiki;

import android.content.pm.ActivityInfo;
import android.view.WindowManager;
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
