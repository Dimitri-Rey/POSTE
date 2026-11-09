package app.poste;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.lang.ref.WeakReference;
import org.json.JSONObject;

/** Verrouille l'application par empreinte (ou code du téléphone) au lancement et au retour. */
public class MainActivity extends BridgeActivity {

    private static final long DELAI_RELOCK_MS = 5 * 60 * 1000;
    private static final int METHODES =
        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private boolean verrouille = true;
    private boolean demandeEnCours = false;
    private long quitteLe = 0;
    private boolean modeJeu = false;

    /** L'écran de Poste, déverrouillé et au premier plan ; vide dès qu'on le quitte. */
    private static volatile WeakReference<MainActivity> aLecran = new WeakReference<>(null);

    /**
     * Notification reçue pendant que Poste est à l'écran : la page l'affiche à sa façon (bandeau discret)
     * au lieu de la barre du téléphone. Renvoie faux si Poste n'est pas à l'écran.
     */
    static boolean montrerDansAppli(String titre, String texte, String lien) {
        MainActivity ecran = aLecran.get();
        if (ecran == null || ecran.getBridge() == null) {
            return false;
        }
        String appel = "window.posteNotif&&window.posteNotif(" + JSONObject.quote(titre) + "," + JSONObject.quote(texte) + ","
            + JSONObject.quote(lien) + ")";
        ecran.runOnUiThread(() -> ecran.getBridge().getWebView().evaluateJavascript(appel, null));
        return true;
    }

    @Override
    public void onCreate(Bundle etat) {
        super.onCreate(etat);
        getBridge().getWebView().setDownloadListener((adresse, agent, disposition, type, taille) -> telecharger(adresse, disposition, type));
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void modeJeu(boolean actif) {
                runOnUiThread(() -> { modeJeu = actif; appliquerModeJeu(); });
            }
        }, "PosteNatif");
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                reculer();
            }
        });
        // Android ne présente ce pont à la page qu'à son prochain chargement.
        getBridge().getWebView().reload();
        masquerBarres();
    }

    /**
     * Touche Retour : la page ferme d'abord sa fenêtre ou sa feuille ouverte, puis on revient à l'écran précédent ;
     * sans écran précédent, on remonte d'un cran ; sur l'accueil, Poste passe en arrière-plan (sans se fermer).
     */
    private void reculer() {
        WebView vue = getBridge().getWebView();
        vue.evaluateJavascript("window.posteRetour?window.posteRetour():'reculer'", choix -> {
            if ("\"fait\"".equals(choix)) {
                return;
            }
            if ("\"quitter\"".equals(choix)) {
                moveTaskToBack(true);
            } else if (vue.canGoBack()) {
                vue.goBack();
            } else {
                vue.evaluateJavascript("window.posteRemonter?window.posteRemonter():false", fait -> {
                    if (!"true".equals(fait)) {
                        moveTaskToBack(true);
                    }
                });
            }
        });
    }

    /** L'application occupe tout l'écran. Un glissement depuis le bord rappelle les barres un instant. */
    private void masquerBarres() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributs = getWindow().getAttributes();
            attributs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributs);
        }
        WindowInsetsControllerCompat barres = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        barres.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        barres.hide(WindowInsetsCompat.Type.systemBars());
    }

    /** Pendant une partie : paysage, sans mise en veille. */
    private void appliquerModeJeu() {
        if (modeJeu) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) {
            masquerBarres();
        }
    }

    /** La vue Web ne télécharge rien seule : le gestionnaire d'Android le fait, avec la session Poste et sur notre seul site. */
    private void telecharger(String adresse, String disposition, String type) {
        if (!adresse.startsWith(BuildConfig.POSTE_SITE + "/")) {
            return;
        }
        String nom = URLUtil.guessFileName(adresse, disposition, type);
        DownloadManager.Request demande = new DownloadManager.Request(Uri.parse(adresse))
            .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(adresse))
            .setMimeType(type)
            .setTitle(nom)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, nom);
        getSystemService(DownloadManager.class).enqueue(demande);
        Toast.makeText(this, "Téléchargement de " + nom, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (quitteLe != 0 && SystemClock.elapsedRealtime() - quitteLe > DELAI_RELOCK_MS) {
            verrouille = true;
        }
        if (verrouille) {
            masquer(true);
            demander();
        } else {
            aLecran = new WeakReference<>(this);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        aLecran = new WeakReference<>(null);
    }

    @Override
    public void onStop() {
        super.onStop();
        quitteLe = SystemClock.elapsedRealtime();
    }

    private void masquer(boolean masque) {
        View vue = getBridge() == null ? null : getBridge().getWebView();
        if (vue != null) {
            vue.setVisibility(masque ? View.INVISIBLE : View.VISIBLE);
        }
    }

    private void ouvrir() {
        verrouille = false;
        demandeEnCours = false;
        masquer(false);
        aLecran = new WeakReference<>(this);
        activerNotifications();
        suivreLien(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!verrouille) {
            suivreLien(intent);
        }
    }

    /** Une notification touchée ouvre la bonne section (uniquement une ancre interne). */
    private void suivreLien(Intent intent) {
        String lien = intent == null ? null : intent.getStringExtra("lien");
        if (lien == null || !lien.matches("/?#[a-z]+(/[A-Za-z0-9_.@%-]+)*")) {
            return;
        }
        intent.removeExtra("lien");
        String ancre = lien.substring(lien.indexOf('#') + 1);
        getBridge().getWebView().evaluateJavascript("location.hash=" + JSONObject.quote(ancre), null);
    }

    private void activerNotifications() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        // Sans cette exemption, Android coupe l'écoute quand l'écran est éteint.
        PowerManager energie = getSystemService(PowerManager.class);
        if (!energie.isIgnoringBatteryOptimizations(getPackageName())) {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        }
        ServiceNotifications.demarrer(this);
    }

    private void demander() {
        if (demandeEnCours) {
            return;
        }
        // Téléphone sans aucun verrouillage : le mot de passe de Poste reste la protection.
        if (BiometricManager.from(this).canAuthenticate(METHODES) != BiometricManager.BIOMETRIC_SUCCESS) {
            ouvrir();
            return;
        }
        demandeEnCours = true;
        BiometricPrompt invite = new BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult resultat) {
                    ouvrir();
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence message) {
                    demandeEnCours = false;
                    finish();
                }
            }
        );
        invite.authenticate(
            new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Déverrouiller Poste")
                .setAllowedAuthenticators(METHODES)
                .build()
        );
    }
}
