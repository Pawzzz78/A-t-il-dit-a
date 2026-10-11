#!/usr/bin/env python3
"""Transcrit gratuitement, sur TON ordinateur, les vidéos YouTube sans sous-titres, puis envoie le résultat au site.

Principe : yt-dlp télécharge l'audio, Whisper (via faster-whisper, libre et gratuit) le transcrit en local, et la
transcription est envoyée à l'admin du site (même base que le reste). Aucun crédit Supadata n'est dépensé.

Installation (Python 3.10+) :
    pip install -r tools/requirements.txt

Exemples :
    # transcrire toutes les vidéos « en échec » (page Synchronisation de l'admin)
    python tools/transcribe.py --site https://TON-SITE.up.railway.app --all-failed

    # ou une vidéo précise (elle est ajoutée au site si elle n'y est pas)
    python tools/transcribe.py --site https://TON-SITE.up.railway.app https://www.youtube.com/watch?v=XXXXXXXXXXX

Le mot de passe de l'admin est lu dans ADMIN_PASSWORD, sinon demandé. Ne le mets jamais dans un fichier du dépôt.
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
import tempfile
from pathlib import Path

DEFAULT_PROMPT = "David Lisnard, Cannes, Nouvelle Énergie, Association des maires de France."
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def log(*args) -> None:
    print(*args, flush=True)


# --------------------------------------------------------------------------- fonctions pures


def extract_video_id(value: str) -> str | None:
    """URL YouTube (watch, youtu.be, shorts, embed, live) ou identifiant brut -> identifiant à 11 caractères."""
    value = value.strip()
    if ID_RE.match(value):
        return value
    for pattern in (r"[?&]v=([A-Za-z0-9_-]{11})", r"youtu\.be/([A-Za-z0-9_-]{11})", r"/(?:shorts|embed|live|v)/([A-Za-z0-9_-]{11})"):
        m = re.search(pattern, value)
        if m:
            return m.group(1)
    return None


def to_payload(whisper_segments) -> list[dict]:
    """Segments Whisper (start/end en secondes) -> segments du site (millisecondes), sans les segments vides."""
    out = []
    for s in whisper_segments:
        text = " ".join(str(s.text).split())
        if not text:
            continue
        start = max(0.0, float(s.start))
        out.append({"start_ms": int(round(start * 1000)), "duration_ms": max(0, int(round((float(s.end) - start) * 1000))), "text": text})
    return out


def _srt_time(ms: int) -> str:
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, milli = divmod(rest, 1000)
    return f"{h:02}:{m:02}:{s:02},{milli:03}"


def format_srt(segments: list[dict]) -> str:
    blocks = []
    for i, s in enumerate(segments, 1):
        end = s["start_ms"] + (s.get("duration_ms") or 0)
        blocks.append(f"{i}\n{_srt_time(s['start_ms'])} --> {_srt_time(end)}\n{s['text']}\n")
    return "\n".join(blocks)


# ------------------------------------------------------------------------------------- site


class Site:
    """Petit client de l'API d'administration du site."""

    def __init__(self, base_url: str, password: str, session=None):
        import requests

        self.base = base_url.rstrip("/")
        self.session = session or requests.Session()
        r = self.session.post(f"{self.base}/api/admin/login", json={"password": password}, timeout=30)
        if r.status_code != 200:
            detail = r.json().get("error") if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
            raise SystemExit(f"Connexion à l'admin refusée ({r.status_code}) : {detail}")

    def _call(self, method: str, path: str, **kwargs):
        r = self.session.request(method, f"{self.base}/api/admin{path}", timeout=kwargs.pop("timeout", 120), **kwargs)
        data = r.json() if r.content else {}
        if not r.ok:
            raise RuntimeError(f"{data.get('error', r.reason)} ({r.status_code})")
        return data

    def failed_videos(self) -> list[dict]:
        return self._call("GET", "/sync/overview")["failed"]

    def find_video(self, youtube_id: str) -> dict | None:
        return next((v for v in self._call("GET", "/videos") if v["youtube_id"] == youtube_id), None)

    def create_video(self, youtube_id: str) -> dict:
        created = self._call("POST", "/videos", json={"input": youtube_id, "mode": "empty"})
        return {"id": created["id"], "youtube_id": youtube_id, "title": youtube_id, "segment_count": 0}

    def upload(self, video_id: int, segments: list[dict], lang: str, overwrite: bool) -> int:
        body = {"segments": segments, "source": "whisper", "lang": lang, "overwrite": overwrite}
        return self._call("POST", f"/videos/{video_id}/transcript", json=body, timeout=300)["segment_count"]


# --------------------------------------------------------------------- audio et transcription


def download_audio(youtube_id: str, outdir: Path, cookies_from_browser: str | None = None) -> Path:
    import yt_dlp

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(outdir / "%(id)s.%(ext)s"),
        "quiet": True,
        "noprogress": True,
        "noplaylist": True,
    }
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={youtube_id}", download=True)
        return Path(ydl.prepare_filename(info))


def load_model(size: str):
    from faster_whisper import WhisperModel

    log(f"Chargement du modèle Whisper « {size} » (téléchargé au premier lancement)…")
    return WhisperModel(size, device="auto", compute_type="auto")


def transcribe_file(model, audio: Path, language: str, prompt: str) -> list[dict]:
    segments, info = model.transcribe(
        str(audio),
        language=language,
        beam_size=5,
        vad_filter=True,  # ignore les silences et la musique
        condition_on_previous_text=False,  # évite les boucles de répétitions
        initial_prompt=prompt or None,  # oriente l'orthographe des noms propres
    )
    out, last_pct = [], -1
    total = getattr(info, "duration", 0) or 0
    for s in segments:
        out.append(s)
        if total:
            pct = int(100 * min(s.end, total) / total)
            if pct // 10 != last_pct // 10:
                log(f"  transcription : {pct} %")
                last_pct = pct
    return to_payload(out)


# ---------------------------------------------------------------------------------- programme


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Transcrit en local (Whisper) des vidéos sans sous-titres et les envoie au site.")
    p.add_argument("videos", nargs="*", help="URL(s) ou identifiant(s) YouTube")
    p.add_argument("--all-failed", action="store_true", help="toutes les vidéos « en échec » de la page Synchronisation")
    p.add_argument("--site", default=os.environ.get("SITE_URL"), help="adresse du site (ou variable SITE_URL)")
    p.add_argument("--password", default=os.environ.get("ADMIN_PASSWORD"), help="mot de passe admin (ou variable ADMIN_PASSWORD, ou demandé)")
    p.add_argument("--model", default="small", help="taille du modèle : tiny, base, small (défaut), medium, large-v3, large-v3-turbo")
    p.add_argument("--language", default="fr", help="langue parlée (défaut : fr)")
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="mots à bien orthographier (noms propres) ; vide pour désactiver")
    p.add_argument("--overwrite", action="store_true", help="remplacer une transcription existante (à éviter : écrase les corrections)")
    p.add_argument("--srt-dir", help="écrit aussi un fichier .srt par vidéo dans ce dossier")
    p.add_argument("--no-upload", action="store_true", help="ne pas envoyer au site (utile avec --srt-dir)")
    p.add_argument("--cookies-from-browser", help="navigateur dont reprendre les cookies si YouTube bloque le téléchargement (chrome, firefox…)")
    args = p.parse_args(argv)
    if not args.videos and not args.all_failed:
        p.error("indique une vidéo ou --all-failed")
    if not args.site:
        p.error("indique l'adresse du site avec --site (ou la variable SITE_URL)")
    return args


def main(argv=None, *, site_factory=Site, download=download_audio, transcribe=transcribe_file, model_loader=load_model) -> int:
    args = parse_args(argv)
    password = args.password or getpass.getpass("Mot de passe de l'admin : ")
    site = site_factory(args.site, password)

    # 1. liste des vidéos à traiter
    targets: list[dict] = []
    if args.all_failed:
        targets += [{"id": v["id"], "youtube_id": v["youtube_id"], "title": v["title"]} for v in site.failed_videos()]
    for raw in args.videos:
        youtube_id = extract_video_id(raw)
        if not youtube_id:
            log(f"Ignoré (pas une vidéo YouTube) : {raw}")
            continue
        video = site.find_video(youtube_id)
        if video and video.get("segment_count", 0) > 0 and not args.overwrite:
            log(f"Déjà transcrite, ignorée : {video['title']} (utilise --overwrite pour la refaire)")
            continue
        video = video or site.create_video(youtube_id)
        targets.append({"id": video["id"], "youtube_id": youtube_id, "title": video["title"]})
    if not targets:
        log("Rien à transcrire.")
        return 0
    log(f"{len(targets)} vidéo(s) à transcrire.")

    # 2. transcription, une vidéo après l'autre
    model = None
    done, failed = 0, 0
    srt_dir = Path(args.srt_dir) if args.srt_dir else None
    if srt_dir:
        srt_dir.mkdir(parents=True, exist_ok=True)
    for i, t in enumerate(targets, 1):
        log(f"\n[{i}/{len(targets)}] {t['title']} ({t['youtube_id']})")
        try:
            with tempfile.TemporaryDirectory(prefix="atildita-") as tmp:
                log("  téléchargement de l'audio…")
                audio = download(t["youtube_id"], Path(tmp), args.cookies_from_browser)
                model = model or model_loader(args.model)
                segments = transcribe(model, audio, args.language, args.prompt)
            if not segments:
                raise RuntimeError("aucune parole détectée")
            if srt_dir:
                (srt_dir / f"{t['youtube_id']}.srt").write_text(format_srt(segments), encoding="utf-8")
            if args.no_upload:
                log(f"  {len(segments)} segments (non envoyés).")
            else:
                count = site.upload(t["id"], segments, args.language, args.overwrite)
                log(f"  envoyée : {count} segments.")
            done += 1
        except Exception as e:  # une vidéo en échec ne bloque pas les suivantes
            failed += 1
            log(f"  ÉCHEC : {e}")
    log(f"\nTerminé : {done} réussie(s), {failed} en échec.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
