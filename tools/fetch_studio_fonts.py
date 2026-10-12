#!/usr/bin/env python3
"""Télécharge les polices du studio de clips (Google Fonts, toutes sous licence SIL OFL 1.1) et écrit le manifeste.

Usage : python3 tools/fetch_studio_fonts.py
- Les TTF vont dans public/fonts/studio/ (servis au navigateur pour l'aperçu ET lus par ffmpeg/libass pour le rendu).
- Le manifeste src/studio/fonts.json liste, pour chaque police, son identifiant, son « nom complet » lu dans le fichier avec
  fc-scan (unique par fichier : c'est lui qui sert de « Fontname » aux sous-titres ASS, vérifié visuellement avec libass) et sa
  catégorie.
"""
import json, re, struct, subprocess, urllib.request, pathlib, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "fonts" / "studio"
MANIFEST = ROOT / "src" / "studio" / "fonts.json"

# (id, nom Google Fonts, graisse, libellé, catégorie)
FONTS = [
    ("anton", "Anton", 400, "Anton", "Impact"),
    ("bebas-neue", "Bebas Neue", 400, "Bebas Neue", "Impact"),
    ("archivo-black", "Archivo Black", 400, "Archivo Black", "Impact"),
    ("oswald", "Oswald", 700, "Oswald", "Impact"),
    ("barlow-condensed", "Barlow Condensed", 800, "Barlow Condensed", "Impact"),
    ("passion-one", "Passion One", 700, "Passion One", "Impact"),
    ("montserrat", "Montserrat", 800, "Montserrat", "Moderne"),
    ("poppins", "Poppins", 800, "Poppins", "Moderne"),
    ("inter", "Inter", 800, "Inter", "Moderne"),
    ("roboto", "Roboto", 900, "Roboto", "Moderne"),
    ("rubik", "Rubik", 800, "Rubik", "Moderne"),
    ("kanit", "Kanit", 800, "Kanit", "Moderne"),
    ("luckiest-guy", "Luckiest Guy", 400, "Luckiest Guy", "Fun"),
    ("bangers", "Bangers", 400, "Bangers", "Fun"),
    ("lilita-one", "Lilita One", 400, "Lilita One", "Fun"),
    ("paytone-one", "Paytone One", 400, "Paytone One", "Fun"),
    ("titan-one", "Titan One", 400, "Titan One", "Fun"),
    ("righteous", "Righteous", 400, "Righteous", "Fun"),
    ("permanent-marker", "Permanent Marker", 400, "Permanent Marker", "Écriture"),
    ("pacifico", "Pacifico", 400, "Pacifico", "Écriture"),
    ("lobster", "Lobster", 400, "Lobster", "Écriture"),
    ("playfair-display", "Playfair Display", 800, "Playfair Display", "Élégante"),
]

def em_ratio(data):
    """unitsPerEm / (usWinAscent + usWinDescent) : libass dessine un texte de « taille ASS » N avec une hauteur d'em de
    N × ce rapport (mesuré : écart < 1 % sur les 22 polices). L'éditeur raisonne en taille d'em (comme en CSS)."""
    n = struct.unpack(">H", data[4:6])[0]
    tabs = {}
    for i in range(n):
        tag, _, off, _ln = struct.unpack(">4sIII", data[12 + 16 * i:28 + 16 * i])
        tabs[tag.decode()] = off
    upm = struct.unpack(">H", data[tabs["head"] + 18:tabs["head"] + 20])[0]
    win_a, win_d = struct.unpack(">HH", data[tabs["OS/2"] + 74:tabs["OS/2"] + 78])
    if win_a + win_d:
        return round(upm / (win_a + win_d), 4)
    asc, desc = struct.unpack(">hh", data[tabs["hhea"] + 4:tabs["hhea"] + 8])
    return round(upm / (asc - desc), 4)

def cap_em(fonts_dir, ass_name, ratio):
    """Largeur d'une capitale « H » en fraction d'em, mesurée avec libass (sert à estimer la largeur d'un mot pour le réduire
    avant qu'il ne déborde de l'écran). Nécessite ffmpeg et numpy ; renvoie 0.62 si indisponible."""
    try:
        import numpy as np
        ass = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 400\nWrapStyle: 2\n[V4+ Styles]\n"
               "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
               f"Style: S,{ass_name},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n"
               "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
               "Dialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,{\\pos(100,100)}HHHH\n")
        with tempfile.NamedTemporaryFile("w", suffix=".ass", delete=False) as f:
            f.write(ass)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x400:d=1", "-vf", f"ass={f.name}:fontsdir={fonts_dir}", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
        img = np.frombuffer(raw, dtype=np.uint8).reshape(400, 1080) > 128
        xs = np.where(img)[1]
        return round((xs.max() - xs.min() + 1) / 4 / (100 * ratio), 3)
    except Exception:  # noqa: BLE001
        return 0.62

def get(url):
    # l'API de Google ne renvoie des TTF statiques qu'à un client « simple » (pas de navigateur moderne)
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    return urllib.request.urlopen(req, timeout=60).read()

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    manifest, failed = [], []
    for fid, name, weight, label, cat in FONTS:
        try:
            css = get(f"https://fonts.googleapis.com/css?family={name.replace(' ', '+')}:{weight}").decode()
            urls = re.findall(r"url\((https://[^)]+\.ttf)\)", css)
            if not urls:
                raise RuntimeError("pas de TTF dans la réponse")
            data = get(urls[-1])  # la dernière entrée est le sous-ensemble « latin »
            path = OUT / f"{fid}.ttf"
            path.write_bytes(data)
            info = subprocess.run(["fc-scan", "--format", "%{family[0]}|%{fullname[0]}|%{style[0]}|%{weight}", str(path)], capture_output=True, text=True, check=True).stdout.split("|")
            manifest.append({"id": fid, "label": label, "category": cat, "file": f"{fid}.ttf", "ass_name": info[1], "family": info[0], "style": info[2], "em_ratio": em_ratio(data)})
            manifest[-1]["cap_em"] = cap_em(OUT, info[1], manifest[-1]["em_ratio"])
            print(f"ok  {fid:18s} {len(data)//1024:4d} Ko  « {info[1]} »  em {manifest[-1]['em_ratio']}  H {manifest[-1]['cap_em']}")
        except Exception as e:  # noqa: BLE001
            failed.append(fid)
            print(f"ÉCHEC {fid}: {e}", file=sys.stderr)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (OUT / "LICENSES.txt").write_text(
        "Polices du studio de clips : Google Fonts, SIL Open Font License 1.1 (https://openfontlicense.org).\n"
        "Libre usage, y compris commercial ; les polices ne peuvent pas être vendues seules.\n\n"
        + "\n".join(f"- {m['label']} ({m['file']})" for m in manifest) + "\n"
    )
    if failed:
        sys.exit(f"Polices manquantes : {', '.join(failed)}")

if __name__ == "__main__":
    main()
