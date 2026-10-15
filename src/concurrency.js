/**
 * Appelle `fn(i)` pour i de 0 à count - 1, `limit` appels à la fois. Après une erreur, plus aucun nouvel appel n'est lancé (les appels
 * payants à un modèle ne continuent pas pour un résultat qui sera jeté) et la première erreur est relancée.
 */
export async function forEachLimit(count, limit, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < count) {
      const i = next++;
      try {
        await fn(i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}
