"""Tests du script (sans réseau ni Whisper) : python -m unittest tools/test_transcribe.py"""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import transcribe as t  # noqa: E402


class PureFunctions(unittest.TestCase):
    def test_extract_video_id(self):
        vid = "dQw4w9WgXcQ"
        for value in (vid, f"https://www.youtube.com/watch?v={vid}&t=10s", f"https://youtu.be/{vid}?si=x", f"https://youtube.com/shorts/{vid}", f"https://www.youtube.com/live/{vid}"):
            self.assertEqual(t.extract_video_id(value), vid, value)
        self.assertIsNone(t.extract_video_id("pas une vidéo"))

    def test_to_payload_millisecondes_et_segments_vides(self):
        segs = [SimpleNamespace(start=1.2345, end=3.5, text="  bonjour   à tous "), SimpleNamespace(start=4, end=5, text="   "), SimpleNamespace(start=-0.5, end=1, text="x")]
        self.assertEqual(
            t.to_payload(segs),
            [{"start_ms": 1234, "duration_ms": 2266, "text": "bonjour à tous"}, {"start_ms": 0, "duration_ms": 1000, "text": "x"}],
        )

    def test_format_srt(self):
        srt = t.format_srt([{"start_ms": 3_723_500, "duration_ms": 2500, "text": "un"}, {"start_ms": 0, "duration_ms": 0, "text": "deux"}])
        self.assertEqual(srt, "1\n01:02:03,500 --> 01:02:06,000\nun\n\n2\n00:00:00,000 --> 00:00:00,000\ndeux\n")


class FakeSite:
    def __init__(self, failed=(), videos=()):
        self._failed, self._videos, self.uploads, self.created = list(failed), list(videos), [], []

    def failed_videos(self):
        return self._failed

    def find_video(self, youtube_id):
        return next((v for v in self._videos if v["youtube_id"] == youtube_id), None)

    def create_video(self, youtube_id):
        self.created.append(youtube_id)
        return {"id": 99, "youtube_id": youtube_id, "title": youtube_id, "segment_count": 0}

    def upload(self, video_id, segments, lang, overwrite):
        self.uploads.append((video_id, segments, lang, overwrite))
        return len(segments)


SEGMENTS = [{"start_ms": 0, "duration_ms": 1000, "text": "bonjour"}]


class Flow(unittest.TestCase):
    def run_main(self, argv, site, transcribe=lambda *a: SEGMENTS, download=None):
        calls = {"download": [], "model": 0}

        def fake_download(youtube_id, outdir, cookies):
            calls["download"].append(youtube_id)
            return outdir / f"{youtube_id}.m4a"

        def fake_model(size):
            calls["model"] += 1
            return object()

        code = t.main(["--site", "http://x", "--password", "pw", *argv], site_factory=lambda b, p: site, download=download or fake_download, transcribe=transcribe, model_loader=fake_model)
        return code, calls

    def test_all_failed(self):
        site = FakeSite(failed=[{"id": 1, "youtube_id": "AAAAAAAAAAA", "title": "A"}, {"id": 2, "youtube_id": "BBBBBBBBBBB", "title": "B"}])
        code, calls = self.run_main(["--all-failed"], site)
        self.assertEqual(code, 0)
        self.assertEqual(calls["download"], ["AAAAAAAAAAA", "BBBBBBBBBBB"])
        self.assertEqual(calls["model"], 1)  # le modèle n'est chargé qu'une fois
        self.assertEqual([(u[0], u[2], u[3]) for u in site.uploads], [(1, "fr", False), (2, "fr", False)])

    def test_video_inconnue_creee_et_deja_transcrite_ignoree(self):
        site = FakeSite(videos=[{"id": 5, "youtube_id": "CCCCCCCCCCC", "title": "C", "segment_count": 10}])
        code, calls = self.run_main(["CCCCCCCCCCC", "https://youtu.be/DDDDDDDDDDD", "n'importe quoi"], site)
        self.assertEqual(code, 0)
        self.assertEqual(site.created, ["DDDDDDDDDDD"])
        self.assertEqual(calls["download"], ["DDDDDDDDDDD"])  # C a déjà une transcription : jamais retouchée
        self.assertEqual([u[0] for u in site.uploads], [99])

    def test_overwrite_explicite(self):
        site = FakeSite(videos=[{"id": 5, "youtube_id": "CCCCCCCCCCC", "title": "C", "segment_count": 10}])
        code, _ = self.run_main(["--overwrite", "CCCCCCCCCCC"], site)
        self.assertEqual((code, site.uploads[0][3]), (0, True))

    def test_une_video_en_echec_ne_bloque_pas_les_suivantes(self):
        site = FakeSite(failed=[{"id": 1, "youtube_id": "AAAAAAAAAAA", "title": "A"}, {"id": 2, "youtube_id": "BBBBBBBBBBB", "title": "B"}])

        def transcribe(model, audio, language, prompt):
            if audio.name.startswith("AAAA"):
                raise RuntimeError("audio illisible")
            return SEGMENTS

        code, _ = self.run_main(["--all-failed"], site, transcribe=transcribe)
        self.assertEqual(code, 1)
        self.assertEqual([u[0] for u in site.uploads], [2])

    def test_srt_et_no_upload(self):
        site = FakeSite(failed=[{"id": 1, "youtube_id": "AAAAAAAAAAA", "title": "A"}])
        with tempfile.TemporaryDirectory() as d:
            code, _ = self.run_main(["--all-failed", "--srt-dir", d, "--no-upload"], site)
            self.assertEqual(code, 0)
            self.assertEqual(site.uploads, [])
            self.assertIn("bonjour", (Path(d) / "AAAAAAAAAAA.srt").read_text(encoding="utf-8"))

    def test_aucune_parole(self):
        site = FakeSite(failed=[{"id": 1, "youtube_id": "AAAAAAAAAAA", "title": "A"}])
        code, _ = self.run_main(["--all-failed"], site, transcribe=lambda *a: [])
        self.assertEqual((code, site.uploads), (1, []))


if __name__ == "__main__":
    unittest.main()
