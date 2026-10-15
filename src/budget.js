/**
 * Plafonnement des appels payants à un modèle : par visiteur et par heure, et au total par jour.
 * En mémoire (suffisant pour borner la dépense ; repart à zéro au redémarrage).
 */
import { ipKey, trimMap } from './ip.js';

const MAX_KEYS = 5000;

export function createBudget(getLimits) {
  const perIp = new Map(); // ip -> { count, resetAt }
  const daily = { day: '', count: 0 };
  return {
    /** Réserve un appel si les plafonds le permettent. */
    take(rawIp, now = Date.now()) {
      const { perIpHourly, dailyCap } = getLimits();
      const ip = ipKey(rawIp);
      const day = new Date(now).toISOString().slice(0, 10);
      if (daily.day !== day) Object.assign(daily, { day, count: 0 });
      if (daily.count >= dailyCap) return false;
      const rec = perIp.get(ip);
      if (rec && rec.resetAt > now && rec.count >= perIpHourly) return false;
      if (!rec || rec.resetAt <= now) {
        perIp.delete(ip); // re-insert so the newest window sits last for eviction
        perIp.set(ip, { count: 1, resetAt: now + 3600 * 1000 });
      } else rec.count++;
      daily.count++;
      trimMap(perIp, MAX_KEYS, (r) => r.resetAt <= now);
      return true;
    },
    reset() {
      perIp.clear();
      Object.assign(daily, { day: '', count: 0 });
    },
  };
}
