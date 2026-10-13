#!/usr/bin/env python3
"""Compose les musiques du studio de clips : boucles ORIGINALES, synthétisées ici (numpy), donc sans droits d'auteur à gérer.

Usage : python3 tools/make_studio_music.py [id ...]   (nécessite numpy et ffmpeg ; avec des identifiants, seuls ces morceaux sont recomposés)
Écrit public/music/<id>.mp3 et src/studio/music.json. Les boucles sont « sans couture » (la queue de réverbération est
repliée sur le début), le serveur les répète tant que le clip dure. Fond sonore sous une voix : mixées à bas volume.
"""
import json, pathlib, subprocess, tempfile, wave, zlib
import numpy as np

SR = 44100
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "music"
MANIFEST = ROOT / "src" / "studio" / "music.json"
mtof = lambda m: 440.0 * 2 ** ((m - 69) / 12)

# ---------- briques sonores ------------------------------------------------------------------------------------------
def tt(n): return np.arange(n) / SR
def adsr(n, a, d, s, r):
    e = np.ones(n) * s
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = max(1, min(na, n)); e[:na] = np.linspace(0, 1, na)
    nd = min(nd, n - na); e[na:na + nd] = np.linspace(1, s, nd) if nd > 0 else e[na:na + nd]
    nr = min(nr, n); e[n - nr:] *= np.linspace(1, 0, nr) if nr > 0 else 1
    return e
def lp(x, cutoff, slope=4.0):
    """Passe-bas par FFT, pente douce (pas d'oscillation audible)."""
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / (1 + (f / cutoff) ** slope), len(x))
def hp(x, cutoff):
    return x - lp(x, cutoff, 2.0)
def saw(f, n, detune=(0,), harmonics=24):
    t = tt(n); out = np.zeros(n)
    for c in detune:
        ff = f * 2 ** (c / 1200)
        for k in range(1, min(harmonics, int(9000 / ff)) + 1):
            out += np.sin(2 * np.pi * k * ff * t + k) / k
    return out / len(detune) * 0.6
def fm_ep(f, dur):
    n = int(dur * SR); t = tt(n)
    idx = 1.8 * np.exp(-t * 3.5) + 0.15
    mod = np.sin(2 * np.pi * f * t) * idx
    y = np.sin(2 * np.pi * f * t + mod) + 0.25 * np.sin(2 * np.pi * 2 * f * t + 0.5 * mod) * np.exp(-t * 5)
    return y * np.exp(-t * 1.6) * (1 - np.exp(-t * 400)) * 0.5
def pluck(f, dur, damp=0.996, bright=0.5):
    n = int(dur * SR); L = max(2, int(SR / f)); y = np.zeros(n + L)
    rng = np.random.default_rng(int(f * 10) % 9973)
    y[:L] = (rng.random(L) * 2 - 1) * bright + (1 - bright) * np.sin(np.linspace(0, 2 * np.pi, L, endpoint=False))
    for i in range(L, n + L, L):
        seg = y[i - L:i]; y[i:i + L] = damp * 0.5 * (seg + np.roll(seg, -1))[: len(y[i:i + L])]
    y = y[:n] * (1 - np.exp(-tt(n) * 600)) * 0.7
    return y
def bell(f, dur):
    n = int(dur * SR); t = tt(n)
    return (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t * 2)) * np.exp(-t * 1.3) * 0.25
def sub_bass(f, dur, drive=1.6):
    n = int(dur * SR); t = tt(n)
    y = np.tanh(drive * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)))
    return y * adsr(n, 0.01, 0.1, 0.8, 0.08) * 0.55
def kick(n=None, vol=1.0, deep=45):
    n = n or int(0.42 * SR); t = tt(n)
    f = deep + 90 * np.exp(-t * 28); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 9) * vol
def snare(vol=0.6):
    n = int(0.28 * SR); t = tt(n); rng = np.random.default_rng(7)
    return (hp(rng.random(n) * 2 - 1, 1500) * np.exp(-t * 18) * 0.7 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25) * 0.5) * vol
def clap(vol=0.5):
    n = int(0.22 * SR); t = tt(n); rng = np.random.default_rng(11); y = np.zeros(n)
    for d in (0, 0.012, 0.025):
        i = int(d * SR); y[i:] += hp(rng.random(n - i) * 2 - 1, 1200) * np.exp(-tt(n - i) * 40) * 0.6
    return y * np.exp(-t * 14) * vol * 1.4
def hat(open_=False, vol=0.25):
    n = int((0.25 if open_ else 0.06) * SR); t = tt(n); rng = np.random.default_rng(3 if open_ else 5)
    return hp(rng.random(n) * 2 - 1, 7000) * np.exp(-t * (14 if open_ else 70)) * vol
def timpani(f=70, vol=0.9):
    n = int(1.6 * SR); t = tt(n); rng = np.random.default_rng(2)
    return (np.sin(2 * np.pi * f * (1 + 0.3 * np.exp(-t * 12)) * t) * np.exp(-t * 2.6) + lp(rng.random(n) * 2 - 1, 400) * np.exp(-t * 30) * 0.6) * vol
def riser(dur, vol=0.35):
    n = int(dur * SR); t = tt(n); rng = np.random.default_rng(13)
    x = rng.random(n) * 2 - 1
    return hp(x, 800) * np.linspace(0, 1, n) ** 2 * vol * np.sin(np.linspace(0, 40 * dur, n)) ** 2

def reverb(x, seconds=1.8, mix=0.25, seed=1, damp=3000):
    n = int(seconds * SR); rng = np.random.default_rng(seed)
    ir = (rng.random(n) * 2 - 1) * np.exp(-tt(n) * (6.9 / seconds)); ir = lp(ir, damp, 2.0); ir[0] = 0
    L = len(x) + n; N = 1 << (L - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(ir, N), N)[:L] * 0.06
    out = np.zeros(L); out[:len(x)] += x * (1 - mix); out += wet * mix * 4
    return out

class Track:
    def __init__(self, bpm, bars, tail=2.5):
        self.bpm, self.bars = bpm, bars
        self.beat = 60.0 / bpm; self.n = int(bars * 4 * self.beat * SR); self.tail = int(tail * SR)
        self.buses = {}
    def bus(self, name):
        return self.buses.setdefault(name, np.zeros(self.n + self.tail))
    def put(self, name, sig, beat_pos, vol=1.0):
        b = self.bus(name); i = int(beat_pos * self.beat * SR)
        if i >= len(b): return
        seg = sig[: len(b) - i]; b[i:i + len(seg)] += seg * vol
    def bar(self, k): return k * 4

def finish(track, mix, reverbs=None, master=0.8):
    """Additionne les pistes (volume, réverbération), replie la queue sur le début (boucle sans couture), normalise."""
    reverbs = reverbs or {}
    total = np.zeros(track.n + track.tail)
    for name, vol in mix.items():
        sig = track.bus(name)
        if name in reverbs:
            sec, m = reverbs[name]; r = reverb(sig, sec, m, seed=zlib.crc32(name.encode()) % 100); r = r[: len(total)] if len(r) >= len(total) else np.pad(r, (0, len(total) - len(r)))
            sig = r
        total += sig[: len(total)] * vol
    loop = total[: track.n].copy(); tail = total[track.n:]
    loop[: len(tail)] += tail
    loop -= loop.mean()
    ramp = np.linspace(0, 1, int(0.003 * SR)); loop[: len(ramp)] *= ramp; loop[-len(ramp):] *= ramp[::-1]  # pas de « clic » au raccord
    loop *= master / max(1e-9, np.abs(loop).max())
    return loop

def chord_notes(root, kind):
    shapes = {"maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10), "7": (0, 4, 7, 10), "maj9": (0, 4, 7, 11, 14), "m9": (0, 3, 7, 10, 14), "maj": (0, 4, 7), "m": (0, 3, 7), "sus": (0, 5, 7)}
    return [root + s for s in shapes[kind]]

# ---------- morceaux --------------------------------------------------------------------------------------------------
def lofi():
    T = Track(80, 16); prog = [(48, "maj7"), (45, "m7"), (50, "m7"), (43, "7")]
    for b in range(16):
        root, kind = prog[b % 4]; notes = chord_notes(root + 12, kind)
        for j, m in enumerate(notes): T.put("ep", fm_ep(mtof(m), 3.2), T.bar(b) + 0.03 * j * 4, 0.28)
        T.put("bass", sub_bass(mtof(root - 12), 1.7), T.bar(b), 0.7); T.put("bass", sub_bass(mtof(root - 12 + (7 if b % 2 else 0)), 1.0), T.bar(b) + 2.5, 0.5)
        T.put("drums", kick(vol=0.8), T.bar(b)); T.put("drums", kick(vol=0.5), T.bar(b) + 2.5)
        T.put("drums", snare(0.4), T.bar(b) + 1); T.put("drums", snare(0.4), T.bar(b) + 3)
        for h in range(8): T.put("hats", hat(vol=0.16 if h % 2 else 0.24), T.bar(b) + h * 0.5 + (0.08 if h % 2 else 0))
    rng = np.random.default_rng(1); T.bus("noise")[:] = lp(rng.random(T.n + T.tail) * 2 - 1, 5000) * 0.012
    return finish(T, {"ep": 1.0, "bass": 0.9, "drums": 0.75, "hats": 0.6, "noise": 1.0}, {"ep": (1.4, 0.3)})

def ambient():
    T = Track(60, 16, tail=4.0); prog = [(53, "maj9"), (52, "m7"), (50, "m9"), (48, "maj7")]
    for c in range(4):
        root, kind = prog[c]; notes = chord_notes(root, kind); start = c * 16
        for m in notes:
            n = int(17.5 * SR); sig = saw(mtof(m), n, detune=(-9, 0, 9), harmonics=10); sig = lp(sig, 900 + 150 * (m % 3)) * adsr(n, 3.0, 1, 0.9, 4.0)
            T.put("pad", sig, start, 0.22)
        T.put("pad", sub_bass(mtof(root - 12), 17, drive=1.0), start, 0.5)
    rng = np.random.default_rng(4)
    for k in range(14):
        m = [72, 74, 76, 79, 81, 84][int(rng.integers(0, 6))] + (c * 0)
        T.put("bells", bell(mtof(m), 5.0), 2 + k * 4.4 + float(rng.random()) * 1.5, 0.5)
    return finish(T, {"pad": 1.0, "bells": 0.9}, {"pad": (3.2, 0.35), "bells": (3.0, 0.5)})

def piano():
    T = Track(90, 16); prog = [(48, "maj"), (43, "maj"), (45, "m"), (41, "maj")]
    for b in range(16):
        root, kind = prog[b % 4]; notes = chord_notes(root + 12, kind) + [root + 24]
        pattern = [0, 1, 2, 3, 2, 1, 2, 3]
        for h, p in enumerate(pattern): T.put("keys", fm_ep(mtof(notes[p % len(notes)]), 1.6) * 1.0, T.bar(b) + h * 0.5, 0.34 if h % 2 == 0 else 0.26)
        T.put("bass", sub_bass(mtof(root - 12), 3.2, 1.0), T.bar(b), 0.6)
        if b % 4 in (1, 3): T.put("mel", fm_ep(mtof(notes[-1] + 7 if b % 8 < 4 else notes[-1] + 4), 2.2), T.bar(b) + 3, 0.3)
    return finish(T, {"keys": 1.0, "bass": 0.9, "mel": 0.9}, {"keys": (1.6, 0.28), "mel": (2.2, 0.4)})

def pop():
    T = Track(110, 24); prog = [(48, "maj"), (55, "maj"), (57, "m"), (53, "maj")]
    for b in range(24):
        root, kind = prog[b % 4]; notes = chord_notes(root + 12, kind)
        for beat in range(4): T.put("drums", kick(vol=0.9), T.bar(b) + beat)
        for beat in (1, 3): T.put("drums", clap(0.5), T.bar(b) + beat)
        for h in range(8): T.put("hats", hat(vol=0.22 if h % 2 else 0.1), T.bar(b) + h * 0.5)
        for h in range(8):
            T.put("bass", sub_bass(mtof(root - 12 + (12 if h in (3, 7) else 0)), 0.42, 1.8), T.bar(b) + h * 0.5, 0.55)
        arp = [0, 1, 2, 1, 2, 1, 0, 1, 2, 1, 2, 1, 0, 2, 1, 2]
        for h, p in enumerate(arp):
            n = int(0.3 * SR); sig = lp(saw(mtof(notes[p % len(notes)] + 12), n, harmonics=12), 3500) * adsr(n, 0.004, 0.08, 0.2, 0.1)
            T.put("arp", sig, T.bar(b) + h * 0.25, 0.22 if h % 4 == 0 else 0.16)
        n = int(4 * T.beat * SR + 0.3 * SR)
        for m in notes: T.put("pad", lp(saw(mtof(m), n, detune=(-8, 8), harmonics=8), 1800) * adsr(n, 0.2, 0.3, 0.7, 0.3), T.bar(b), 0.1)
    return finish(T, {"drums": 0.85, "hats": 0.7, "bass": 0.8, "arp": 0.85, "pad": 0.9}, {"arp": (1.0, 0.18), "pad": (1.2, 0.2)})

def tension():
    T = Track(100, 24); prog = [(45, "m"), (41, "maj"), (38, "m"), (40, "maj")]
    for b in range(24):
        root, kind = prog[(b // 2) % 4]
        for h in range(8): T.put("bass", lp(saw(mtof(root - 12), int(0.3 * SR), harmonics=10), 600) * adsr(int(0.3 * SR), 0.005, 0.1, 0.5, 0.1), T.bar(b) + h * 0.5, 0.6 if h % 4 == 0 else 0.4)
        T.put("drums", kick(vol=1.0, deep=40), T.bar(b)); T.put("drums", kick(vol=0.8, deep=40), T.bar(b) + 2)
        if b % 2: T.put("drums", snare(0.35), T.bar(b) + 3)
        if b % 4 == 0: T.put("hit", timpani(55, 1.0), T.bar(b), 0.8)
        if b % 8 == 7: T.put("riser", riser(4 * T.beat), T.bar(b), 1.0)
        n = int(8 * T.beat * SR)
        if b % 2 == 0:
            for m in chord_notes(root + 12, kind):
                s = saw(mtof(m), n, detune=(-10, 0, 10), harmonics=10); lfo = 0.65 + 0.35 * np.sin(2 * np.pi * 5.5 * tt(n))
                T.put("strings", lp(s, 1600) * lfo * adsr(n, 1.2, 0.5, 0.8, 1.0), T.bar(b), 0.18)
    return finish(T, {"bass": 0.9, "drums": 0.8, "hit": 0.8, "riser": 0.7, "strings": 0.9}, {"strings": (2.4, 0.35), "hit": (2.0, 0.4)})

def cinematic():
    T = Track(70, 12, tail=4.0); prog = [(38, "m"), (34, "maj"), (41, "maj"), (36, "maj")]
    for c in range(4):
        root, kind = prog[c]; start = c * 12
        for m in chord_notes(root + 12, kind) + [root + 24]:
            n = int(13.5 * T.beat * SR + 3 * SR); s = saw(mtof(m), n, detune=(-12, -4, 4, 12), harmonics=14)
            T.put("strings", lp(s, 1300) * adsr(n, 2.2, 1, 0.85, 3.0), start, 0.16)
        T.put("strings", lp(saw(mtof(root - 12), int(13 * T.beat * SR), harmonics=8), 300) * adsr(int(13 * T.beat * SR), 1.5, 1, 0.9, 2.0), start, 0.5)
        T.put("hit", timpani(mtof(root - 12), 0.9), start, 0.8); T.put("hit", timpani(mtof(root - 12), 0.5), start + 8, 0.6)
        T.put("piano", fm_ep(mtof(root + 31 if c % 2 else root + 24), 4.0), start + 4, 0.35); T.put("piano", fm_ep(mtof(root + 28), 4.0), start + 8, 0.3)
    return finish(T, {"strings": 1.0, "hit": 0.8, "piano": 0.9}, {"strings": (3.5, 0.4), "hit": (3.0, 0.45), "piano": (3.0, 0.5)})

def electro():
    T = Track(124, 32); prog = [(45, "m"), (41, "maj"), (48, "maj"), (43, "maj")]
    kicks = []
    for b in range(32):
        root, kind = prog[(b // 2) % 4]; notes = chord_notes(root + 12, kind)
        for beat in range(4): T.put("drums", kick(vol=1.0), T.bar(b) + beat); kicks.append(T.bar(b) + beat)
        for beat in (1, 3): T.put("drums", clap(0.5), T.bar(b) + beat)
        for h in range(16): T.put("hats", hat(vol=0.2 if h % 4 == 2 else 0.08), T.bar(b) + h * 0.25)
        for h in range(8): T.put("bass", lp(saw(mtof(root - 12), int(0.3 * SR), harmonics=12), 500) * adsr(int(0.3 * SR), 0.004, 0.1, 0.6, 0.08), T.bar(b) + h * 0.5 + 0.25 * (h % 2), 0.55)
        for h in range(16):
            n = int(0.18 * SR); T.put("arp", lp(saw(mtof(notes[[0, 2, 1, 2][h % 4] % len(notes)] + 12), n, harmonics=14), 4200) * adsr(n, 0.003, 0.05, 0.2, 0.06), T.bar(b) + h * 0.25, 0.2)
        if b % 2 == 0:
            n = int(8 * T.beat * SR)
            for m in notes: T.put("pad", lp(saw(mtof(m), n, detune=(-14, -5, 5, 14), harmonics=10), 2200) * adsr(n, 0.3, 0.5, 0.8, 0.5), T.bar(b), 0.11)
        if b % 8 == 7: T.put("riser", riser(4 * T.beat), T.bar(b), 1.0)
    duck = np.ones(T.n + T.tail)
    for k in kicks:
        i = int(k * T.beat * SR); m = min(len(duck) - i, int(0.35 * SR)); duck[i:i + m] = np.minimum(duck[i:i + m], 0.25 + 0.75 * np.linspace(0, 1, m) ** 1.5)
    for name in ("bass", "pad", "arp"): T.buses[name] *= duck
    return finish(T, {"drums": 0.85, "hats": 0.7, "bass": 0.9, "arp": 0.85, "pad": 0.9, "riser": 0.6}, {"arp": (0.8, 0.15), "pad": (1.0, 0.2)})

def acoustic():
    T = Track(100, 24); prog = [(55, "maj"), (50, "maj"), (52, "m"), (48, "maj")]
    for b in range(24):
        root, kind = prog[b % 4]; shape = chord_notes(root, kind) + [root + 12, root + 16 if kind == "maj" else root + 15]
        for s_i, beat in enumerate((0, 1.5, 2, 3.5)):
            for j, m in enumerate(shape[:5]):
                T.put("gtr", pluck(mtof(m + (12 if s_i % 2 else 0)), 1.5 if s_i == 0 else 0.9, 0.994, 0.45), T.bar(b) + beat + 0.018 * j * (1 if s_i % 2 == 0 else -1) + (0.09 if s_i % 2 else 0) * 0, 0.2 if s_i in (0, 2) else 0.14)
        T.put("bass", sub_bass(mtof(root - 12), 1.5, 1.0), T.bar(b), 0.5); T.put("bass", sub_bass(mtof(root - 12 + 7), 1.0), T.bar(b) + 2, 0.4)
        for h in range(8): T.put("shaker", hat(vol=0.09 if h % 2 else 0.14), T.bar(b) + h * 0.5)
        if b % 2 == 1: T.put("drums", snare(0.25), T.bar(b) + 1)
    return finish(T, {"gtr": 1.0, "bass": 0.8, "shaker": 0.7, "drums": 0.7}, {"gtr": (1.3, 0.22)})

def epic():
    """Épique : cordes graves en ostinato, timbales, cuivres puis chœur, montée en trois temps (calme, puissance, plein)."""
    T = Track(84, 24, tail=4.0); prog = [(45, "m"), (41, "maj"), (48, "maj"), (43, "maj")]
    for b in range(24):
        root, kind = prog[(b // 2) % 4]; notes = chord_notes(root + 12, kind)
        power = 0 if b < 4 else (1 if b < 12 else 2)
        for h in range(8):  # ostinato de cordes graves
            n = int(0.26 * SR); T.put("ostinato", lp(saw(mtof(root - 12 + (7 if h % 4 == 3 else 0)), n, detune=(-6, 6), harmonics=10), 700) * adsr(n, 0.01, 0.1, 0.6, 0.08), T.bar(b) + h * 0.5, 0.5 if h % 2 == 0 else 0.34)
        if b % 2 == 0:
            n = int(8 * T.beat * SR + SR)
            for m in notes:
                T.put("strings", lp(saw(mtof(m), n, detune=(-12, -4, 4, 12), harmonics=12), 1500) * adsr(n, 1.4, 0.6, 0.85, 1.2), T.bar(b), 0.14 if power else 0.1)
            if power >= 1:
                for m in notes + [notes[0] + 12]:
                    T.put("brass", lp(saw(mtof(m), n, detune=(-7, 0, 7), harmonics=9), 1900) * adsr(n, 0.5, 0.8, 0.8, 0.9), T.bar(b), 0.16 if power == 2 else 0.1)
            if power == 2:
                for m in (notes[0] + 24, notes[2] + 24):
                    T.put("choir", lp(saw(mtof(m), n, detune=(-9, 9), harmonics=6), 1300) * adsr(n, 1.0, 0.8, 0.9, 1.4) * (0.8 + 0.2 * np.sin(2 * np.pi * 5.2 * tt(n))), T.bar(b), 0.1)
        if b >= 4:
            T.put("drums", timpani(mtof(root - 12), 1.0), T.bar(b), 0.9); T.put("drums", timpani(mtof(root - 12), 0.8), T.bar(b) + 2, 0.7)
        if power == 2:
            T.put("drums", timpani(mtof(root - 12) * 1.5, 0.7), T.bar(b) + 3.5, 0.6); T.put("drums", snare(0.4), T.bar(b) + 1); T.put("drums", snare(0.4), T.bar(b) + 3)
        if b % 8 == 7: T.put("riser", riser(4 * T.beat, 0.5), T.bar(b), 1.0)
    return finish(T, {"ostinato": 0.9, "strings": 1.0, "brass": 0.9, "choir": 0.8, "drums": 0.9, "riser": 0.6}, {"strings": (3.0, 0.4), "brass": (2.6, 0.35), "choir": (3.4, 0.5), "drums": (2.4, 0.3)})

def motivation():
    """Motivation : piano en arpèges, grosse caisse régulière, claps, basse et mélodie qui montent par paliers."""
    T = Track(100, 24); prog = [(48, "maj"), (43, "maj"), (45, "m"), (41, "maj")]
    for b in range(24):
        root, kind = prog[b % 4]; notes = chord_notes(root + 12, kind) + [root + 24]
        lvl = 0 if b < 4 else (1 if b < 12 else 2)
        for h in range(8): T.put("piano", fm_ep(mtof(notes[[0, 1, 2, 3, 2, 1, 2, 3][h]]), 1.4), T.bar(b) + h * 0.5, 0.3 if h % 2 == 0 else 0.22)
        n = int(4 * T.beat * SR + 0.3 * SR)
        for m in notes[:3]: T.put("pad", lp(saw(mtof(m), n, detune=(-9, 9), harmonics=8), 1700) * adsr(n, 0.3, 0.4, 0.7, 0.4), T.bar(b), 0.1 if lvl else 0.07)
        if lvl >= 1:
            for beat in range(4): T.put("drums", kick(vol=0.9), T.bar(b) + beat)
            for beat in (1, 3): T.put("drums", clap(0.5), T.bar(b) + beat)
            for h in range(8): T.put("hats", hat(vol=0.2 if h % 2 else 0.09), T.bar(b) + h * 0.5)
            for h in range(4): T.put("bass", sub_bass(mtof(root - 12), 0.8, 1.6), T.bar(b) + h, 0.55)
        if lvl == 2:
            for h, step in enumerate([0, 2, 4, 2]):
                n2 = int(0.9 * SR); T.put("lead", lp(saw(mtof(notes[step % len(notes)] + 12), n2, detune=(-6, 6), harmonics=10), 3200) * adsr(n2, 0.01, 0.15, 0.5, 0.3), T.bar(b) + h, 0.2)
        if b % 8 == 7: T.put("riser", riser(4 * T.beat, 0.4), T.bar(b), 1.0)
    return finish(T, {"piano": 1.0, "pad": 0.9, "drums": 0.85, "hats": 0.7, "bass": 0.8, "lead": 0.85, "riser": 0.5}, {"piano": (1.6, 0.3), "pad": (1.4, 0.25), "lead": (1.4, 0.3)})

# (id, titre, ambiance, tempo, fonction, catégorie)
TRACKS = [
    ("lofi-doux", "Lo-fi doux", "Posé, chaleureux", 80, lofi, "autre"),
    ("ambiant-calme", "Ambiant calme", "Planant, discret", 60, ambient, "autre"),
    ("piano-doux", "Piano doux", "Sobre, réfléchi", 90, piano, "autre"),
    ("pop-optimiste", "Pop optimiste", "Entraînant, positif", 110, pop, "motivant"),
    ("tension-actu", "Tension actualité", "Sérieux, dramatique", 100, tension, "epique"),
    ("cinematique", "Cinématique", "Ample, solennel", 70, cinematic, "cinematique"),
    ("electro-motivant", "Électro motivant", "Énergique, rapide", 124, electro, "motivant"),
    ("acoustique-leger", "Acoustique léger", "Naturel, convivial", 100, acoustic, "autre"),
    ("epique-conquete", "Épique : conquête", "Puissant, grandiose", 84, epic, "epique"),
    ("motivation-ascension", "Motivation : ascension", "Déterminé, qui monte", 100, motivation, "motivant"),
]

def write_mp3(sig, path):
    pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        with wave.open(tmp.name, "wb") as w:
            w.setnchannels(1); w.setframerate(SR); w.setsampwidth(2); w.writeframes(pcm.tobytes())
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", str(path)], check=True)

def main(only=None):
    """only : liste d'identifiants à (re)composer ; les autres morceaux et leur entrée du manifeste ne sont pas touchés."""
    OUT.mkdir(parents=True, exist_ok=True); MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    previous = {m["id"]: m for m in json.loads(MANIFEST.read_text())} if MANIFEST.exists() else {}
    manifest = []
    for tid, title, mood, bpm, fn, category in TRACKS:
        entry = previous.get(tid)
        if only is not None and tid not in only and entry:
            entry["category"] = category; manifest.append(entry); continue
        sig = fn(); path = OUT / f"{tid}.mp3"; write_mp3(sig, path)
        dur = round(len(sig) / SR, 1)
        manifest.append({"id": tid, "title": title, "mood": mood, "category": category, "bpm": bpm, "duration_s": dur, "file": f"{tid}.mp3", "license": "Création originale, libre de droits (CC0)"})
        print(f"ok {tid:22s} {dur:5.1f} s  {path.stat().st_size // 1024:5d} Ko  pic {np.abs(sig).max():.2f}  rms {np.sqrt((sig**2).mean()):.3f}")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

if __name__ == "__main__":
    import sys
    main(set(sys.argv[1:]) or None)
