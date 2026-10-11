/**
 * Plafonnement des appels payants à un modèle : par visiteur et par heure, et au total par jour.
 * En mémoire (suffisant pour borner la dépense ; repart à zéro au redémarrage).
 */
export function createBudget(getLimits) {
  const perIp = new Map(); // ip -> { count, resetAt }
  const daily = { day: '', count: 0 };
  return {
    /** Réserve un appel si les plafonds le permettent. */
    take(ip, now = Date.now()) {
      const { perIpHourly, dailyCap } = getLimits();
      const day = new Date(now).toISOString().slice(0, 10);
      if (daily.day !== day) Object.assign(daily, { day, count: 0 });
      if (daily.count >= dailyCap) return false;
      const rec = perIp.get(ip);
      if (rec && rec.resetAt > now && rec.count >= perIpHourly) return false;
      if (!rec || rec.resetAt <= now) perIp.set(ip, { count: 1, resetAt: now + 3600 * 1000 });
      else rec.count++;
      daily.count++;
      if (perIp.size > 5000) perIp.clear(); // borne mémoire
      return true;
    },
    reset() {
      perIp.clear();
      Object.assign(daily, { day: '', count: 0 });
    },
  };
}
