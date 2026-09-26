package com.agustinyarrus.carrona;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
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

    /** Lo que contesta el juego cuando ATRÁS ya no tiene nada que cerrar. */
    private static final String BACK_EXIT = "exit";

    /** Le pregunta al juego qué hacer con ATRÁS; si todavía no cargó, la respuesta es salir. */
    private static final String ASK_GAME_ABOUT_BACK =
        "(function(){ try { return window.carrona ? window.carrona.backButton() : 'exit'; } catch (e) { return 'exit'; } })()";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersive();
        // ATRÁS por el despachador de AndroidX y no por onBackPressed(): con targetSdk 36 en
        // Android 16 el sistema ya no llama a onBackPressed ni reparte KEYCODE_BACK (atrás
        // predictivo), pero sí invoca los OnBackPressedCallback registrados; en versiones
        // anteriores el despachador recibe el mismo evento por el camino clásico. Siempre
        // habilitado: el juego decide, y el «salir» lo hacemos nosotros mandando la tarea al fondo.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { askGameAboutBack(); }
        });
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
    private void askGameAboutBack() {
        if (bridge == null || bridge.getWebView() == null) { moveTaskToBack(true); return; }
        bridge.getWebView().evaluateJavascript(ASK_GAME_ABOUT_BACK,
            value -> { if (value != null && value.contains(BACK_EXIT)) runOnUiThread(() -> moveTaskToBack(true)); });
    }
}
