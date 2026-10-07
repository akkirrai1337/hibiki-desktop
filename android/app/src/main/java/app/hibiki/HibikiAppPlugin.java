package app.hibiki;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Rational;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.view.Window;
import android.view.WindowManager;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

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

    /**
     * Hands a text file to the system share sheet - the phone's "save as" for the exported log:
     * from there it goes to a messenger, the mail, or Files. Written under the cache dir, which
     * the FileProvider already exposes (res/xml/file_paths.xml).
     */
    @PluginMethod
    public void shareText(PluginCall call) {
        String name = call.getString("name", "hibiki.txt").replaceAll("[\\\\/]", "_");
        String text = call.getString("text", "");
        try {
            File dir = new File(getContext().getCacheDir(), "shared");
            dir.mkdirs();
            File file = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
            android.net.Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            // The file alone: no EXTRA_SUBJECT/EXTRA_TEXT, which Telegram and others post as a caption
            // under it. ClipData carries the read grant through the chooser to the picked app.
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(android.content.ClipData.newRawUri(name, uri));
            Intent chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    // --- picture in picture --------------------------------------------------------------------
    // As the Kotlin app has it: the player's PiP button (and, on Android 12+, leaving the app while
    // a video plays) shrinks the app to a small window with the picture, whose buttons are the
    // previous episode, play/pause, the next episode and audio only (the window goes, the sound
    // stays). The page keeps this up to date (updatePip) and hears the buttons as "pipAction";
    // the mode itself arrives as the "hibikipip" window event (MainActivity).

    private static final String PIP_ACTION = "app.hibiki.PIP_ACTION";
    private boolean pipEnabled = false;
    private boolean pipPlaying = false;
    private boolean pipHasPrevious = false;
    private boolean pipHasNext = false;
    private int pipWidth = 16;
    private int pipHeight = 9;
    private JSObject pipLabels = new JSObject();
    private BroadcastReceiver pipReceiver;

    /** A hibiki:// link the app was started with, kept until the page asks for it (takeLaunchUrl). */
    private String launchUrl;

    @Override
    public void load() {
        launchUrl = deepLinkOf(getActivity().getIntent());
        pipReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject event = new JSObject();
                event.put("action", intent.getStringExtra("action"));
                notifyListeners("pipAction", event);
            }
        };
        ContextCompat.registerReceiver(getContext(), pipReceiver, new IntentFilter(PIP_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /** A hibiki:// link arriving while the app runs (singleTask: the same activity gets it). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String url = deepLinkOf(intent);
        if (url == null) return;
        JSObject event = new JSObject();
        event.put("url", url);
        notifyListeners("deepLink", event, true);
    }

    /** The link the app was started with, once: a later call answers null. */
    @PluginMethod
    public void takeLaunchUrl(PluginCall call) {
        JSObject result = new JSObject();
        result.put("url", launchUrl);
        launchUrl = null;
        call.resolve(result);
    }

    private static String deepLinkOf(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        String url = intent.getDataString();
        return url != null && url.startsWith("hibiki://") ? url : null;
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (pipReceiver != null) {
            try {
                getContext().unregisterReceiver(pipReceiver);
            } catch (IllegalArgumentException ignored) {
                // Already gone with the context.
            }
            pipReceiver = null;
        }
    }

    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    /** The player's state, for the window's buttons and its shape; enabled = a video is on screen. */
    @PluginMethod
    public void updatePip(PluginCall call) {
        pipEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        pipPlaying = Boolean.TRUE.equals(call.getBoolean("playing", false));
        pipHasPrevious = Boolean.TRUE.equals(call.getBoolean("hasPrevious", false));
        pipHasNext = Boolean.TRUE.equals(call.getBoolean("hasNext", false));
        Integer width = call.getInt("width");
        Integer height = call.getInt("height");
        if (width != null && height != null && width > 0 && height > 0) {
            pipWidth = width;
            pipHeight = height;
        }
        JSObject labels = call.getObject("labels");
        if (labels != null) pipLabels = labels;
        getActivity().runOnUiThread(() -> {
            if (!pipSupported()) return;
            try {
                getActivity().setPictureInPictureParams(buildPipParams());
            } catch (IllegalStateException | IllegalArgumentException ignored) {
                // An activity being torn down, or a shape the system refuses: keep the old params.
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean entered = false;
            if (pipSupported()) {
                try {
                    entered = getActivity().enterPictureInPictureMode(buildPipParams());
                } catch (IllegalStateException | IllegalArgumentException ignored) {
                    entered = false;
                }
            }
            JSObject result = new JSObject();
            result.put("entered", entered);
            call.resolve(result);
        });
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams buildPipParams() {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
        // The system takes shapes between 1:2.39 and 2.39:1 only.
        float ratio = Math.max(1f / 2.39f, Math.min(2.39f, (float) pipWidth / pipHeight));
        builder.setAspectRatio(new Rational(Math.round(ratio * 1000), 1000));

        List<RemoteAction> actions = new ArrayList<>();
        if (pipHasPrevious) actions.add(pipAction("previous", R.drawable.ic_pip_previous, label("previous", "Previous episode"), 1));
        actions.add(pipPlaying
            ? pipAction("toggle", R.drawable.ic_pip_pause, label("pause", "Pause"), 2)
            : pipAction("toggle", R.drawable.ic_pip_play, label("play", "Play"), 2));
        if (pipHasNext) actions.add(pipAction("next", R.drawable.ic_pip_next, label("next", "Next episode"), 3));
        // Audio only where the window has room for a fourth button (most show three).
        if (actions.size() < getActivity().getMaxNumPictureInPictureActions()) {
            actions.add(0, pipAction("audioOnly", R.drawable.ic_pip_audio_only, label("audioOnly", "Audio only"), 4));
        }
        builder.setActions(actions);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Leaving the app while a video plays takes it along in the small window.
            builder.setAutoEnterEnabled(pipEnabled && pipPlaying);
            builder.setSeamlessResizeEnabled(false);
        }
        return builder.build();
    }

    private String label(String key, String fallback) {
        String value = pipLabels.optString(key, "");
        return value.isEmpty() ? fallback : value;
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private RemoteAction pipAction(String action, int icon, String title, int requestCode) {
        Intent intent = new Intent(PIP_ACTION).setPackage(getContext().getPackageName()).putExtra("action", action);
        PendingIntent pending = PendingIntent.getBroadcast(getContext(), requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new RemoteAction(Icon.createWithResource(getContext(), icon), title, title, pending);
    }
}
