package com.agustinyarrus.carrona;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * CARRONA en Android: el juego web dentro del WebView de Capacitor, a pantalla
 * completa inmersiva, apaisado, sin que se apague la pantalla, y con el botón
 * ATRÁS del sistema mandado al juego (pausa, cerrar la pantalla de arriba); en
 * el menú principal manda la app al fondo en vez de matarla.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersive();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /** Barras del sistema escondidas (inmersivo pegajoso): un gesto desde el borde las asoma un momento. */
    private void applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    /** ATRÁS: lo decide el juego (window.carrona.backButton() devuelve 'handled' o 'exit'). */
    @Override
    public void onBackPressed() {
        if (bridge == null || bridge.getWebView() == null) { super.onBackPressed(); return; }
        bridge.getWebView().evaluateJavascript(
            "(function(){ try { return window.carrona ? window.carrona.backButton() : 'exit'; } catch (e) { return 'exit'; } })()",
            value -> { if (value != null && value.contains("exit")) runOnUiThread(() -> moveTaskToBack(true)); });
    }
}
