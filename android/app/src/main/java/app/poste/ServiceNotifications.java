package app.poste;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Écoute le serveur ntfy de Poste et affiche ses messages, sans aucun service Google. */
public class ServiceNotifications extends Service {

    private static final String TAG = "PosteNotifs";
    private static final String SITE = BuildConfig.POSTE_SITE;
    private static final String CANAL_MESSAGES = "messages";
    private static final String CANAL_ECOUTE = "ecoute";
    private static final int ID_ECOUTE = 1;
    private static final int LECTURE_MAX_MS = 120_000;
    private static final long ATTENTE_MAX_MS = 300_000;

    private volatile boolean actif;
    private Thread fil;

    public static void demarrer(Context contexte) {
        contexte.startForegroundService(new Intent(contexte, ServiceNotifications.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager gestion = getSystemService(NotificationManager.class);
        gestion.createNotificationChannel(new NotificationChannel(CANAL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH));
        gestion.createNotificationChannel(new NotificationChannel(CANAL_ECOUTE, "Écoute en arrière-plan", NotificationManager.IMPORTANCE_MIN));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification ecoute = new NotificationCompat.Builder(this, CANAL_ECOUTE)
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
            .setContentTitle("Poste écoute les notifications")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_ECOUTE, ecoute, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ID_ECOUTE, ecoute);
        }
        if (fil == null || !fil.isAlive()) {
            actif = true;
            fil = new Thread(this::boucle, "poste-notifs");
            fil.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        actif = false;
        if (fil != null) {
            fil.interrupt();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SharedPreferences reglages() {
        return getSharedPreferences("notifications", MODE_PRIVATE);
    }

    private void boucle() {
        long attente = 5_000;
        while (actif) {
            try {
                if (reglages().getString("jeton", null) == null) {
                    chargerConfig();
                }
                ecouter();
                attente = 5_000;
            } catch (IOException | JSONException err) {
                Log.w(TAG, "Écoute interrompue : " + err.getMessage());
                attente = Math.min(attente * 2, ATTENTE_MAX_MS);
            }
            try {
                Thread.sleep(attente);
            } catch (InterruptedException err) {
                return;
            }
        }
    }

    /** Le jeton ntfy n'est servi qu'à une session Poste connectée (cookie de la WebView). */
    private void chargerConfig() throws IOException, JSONException {
        String cookie = CookieManager.getInstance().getCookie(SITE);
        if (cookie == null) {
            throw new IOException("Pas encore connecté à Poste");
        }
        HttpURLConnection cnx = (HttpURLConnection) new URL(SITE + "/api/notifications/config").openConnection();
        cnx.setRequestProperty("Cookie", cookie);
        cnx.setConnectTimeout(15_000);
        cnx.setReadTimeout(15_000);
        try {
            if (cnx.getResponseCode() != 200) {
                throw new IOException("Configuration refusée : " + cnx.getResponseCode());
            }
            JSONObject config = new JSONObject(lireTout(cnx.getInputStream()));
            if (config.isNull("jeton")) {
                throw new IOException("Serveur de notifications non configuré");
            }
            reglages().edit()
                .putString("url", config.getString("url"))
                .putString("sujet", config.getString("sujet"))
                .putString("jeton", config.getString("jeton"))
                .apply();
        } finally {
            cnx.disconnect();
        }
    }

    private void ecouter() throws IOException, JSONException {
        SharedPreferences r = reglages();
        String depuis = r.getString("dernier", "12h");
        String adresse = r.getString("url", "") + "/" + r.getString("sujet", "") + "/json?since="
            + URLEncoder.encode(depuis, "UTF-8");
        HttpURLConnection cnx = (HttpURLConnection) new URL(adresse).openConnection();
        cnx.setRequestProperty("Authorization", "Bearer " + r.getString("jeton", ""));
        cnx.setConnectTimeout(15_000);
        // ntfy envoie un signal de vie toutes les 45 s : un silence plus long signale une coupure.
        cnx.setReadTimeout(LECTURE_MAX_MS);
        try {
            int code = cnx.getResponseCode();
            if (code == 401 || code == 403) {
                r.edit().remove("jeton").apply();
                throw new IOException("Jeton refusé");
            }
            try (BufferedReader lecteur = new BufferedReader(new InputStreamReader(cnx.getInputStream(), StandardCharsets.UTF_8))) {
                String ligne;
                while (actif && (ligne = lecteur.readLine()) != null) {
                    JSONObject e = new JSONObject(ligne);
                    if ("message".equals(e.optString("event"))) {
                        afficher(e);
                        r.edit().putString("dernier", e.getString("id")).apply();
                    }
                }
            }
        } finally {
            cnx.disconnect();
        }
    }

    private void afficher(JSONObject e) {
        // Poste ouvert à l'écran : pas de notification du téléphone, la page s'en charge.
        if (MainActivity.montrerDansAppli(e.optString("title", "Poste"), e.optString("message"), e.optString("click"))) {
            return;
        }
        Intent ouvrir = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("lien", e.optString("click"));
        int id = e.optString("id").hashCode();
        PendingIntent action = PendingIntent.getActivity(this, id, ouvrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String titre = e.optString("title", "Poste");
        String texte = e.optString("message");
        Notification n = new NotificationCompat.Builder(this, CANAL_MESSAGES)
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
            .setContentTitle(titre)
            .setContentText(texte)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(texte))
            .setContentIntent(action)
            .setAutoCancel(true)
            .setPriority(e.optInt("priority", 3) >= 4 ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .build();
        getSystemService(NotificationManager.class).notify(id, n);
    }

    private static String lireTout(InputStream flux) throws IOException {
        ByteArrayOutputStream sortie = new ByteArrayOutputStream();
        byte[] tampon = new byte[4096];
        int lu;
        while ((lu = flux.read(tampon)) != -1) {
            sortie.write(tampon, 0, lu);
        }
        return sortie.toString("UTF-8");
    }
}
