package app.poste;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Relance l'écoute des notifications au démarrage du téléphone. */
public class DemarrageTelephone extends BroadcastReceiver {

    @Override
    public void onReceive(Context contexte, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            ServiceNotifications.demarrer(contexte);
        }
    }
}
