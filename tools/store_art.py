# Arte de la ficha de Google Play, con el lenguaje visual del juego (negro, Cascadia fina, letras espaciadas):
#   store/icon-512.png          el ícono de 512×512 (32 bits, sin transparencia: aplanado sobre el negro del juego)
#   store/feature-graphic.png   el gráfico destacado de 1024×500 sobre una captura real, con el título
#   store/screenshots/phone/*   las capturas pasadas a PNG de 24 bits (Play no quiere canal alfa) y verificadas 16:9
# Corre después de store_shots.mjs.  python tools/store_art.py
import glob, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'store'); os.makedirs(STORE, exist_ok=True)
FONDO = (6, 7, 10)
CREMA = (230, 227, 220)
GRIS = (160, 163, 175)
AMBAR = (255, 210, 74)
FUENTES = [r'C:\Windows\Fonts\CascadiaCode-ExtraLight.ttf', r'C:\Windows\Fonts\CascadiaCode-Light.ttf', r'C:\Windows\Fonts\CascadiaCode.ttf', r'C:\Windows\Fonts\consola.ttf']

def fuente(px):
    for f in FUENTES:
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()

def espaciado(draw, xy, texto, fnt, fill, tracking):
    """Texto con letras espaciadas (como el letter-spacing del juego); devuelve el ancho."""
    x, y = xy
    for ch in texto:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking
    return x - xy[0] - tracking

def ancho(draw, texto, fnt, tracking):
    return sum(draw.textlength(ch, font=fnt) + tracking for ch in texto) - tracking

# ── ícono 512 ─────────────────────────────────────────────────────────────────
src = Image.open(os.path.join(ROOT, 'mobile', 'assets', 'icon-only.png')).convert('RGBA')
icono = Image.new('RGBA', src.size, FONDO + (255,)); icono.alpha_composite(src)
icono = icono.convert('RGB').resize((512, 512), Image.LANCZOS)
icono.save(os.path.join(STORE, 'icon-512.png'), optimize=True)

# ── gráfico destacado 1024×500 ────────────────────────────────────────────────
fondo_src = None
for cand in sorted(glob.glob(os.path.join(STORE, 'screenshots', 'phone', '04-*.png'))) + [os.path.join(ROOT, 'docs', 'android.jpg')]:
    if os.path.exists(cand): fondo_src = cand; break
W, H = 1024, 500
img = Image.new('RGB', (W, H), FONDO)
if fondo_src:
    f = Image.open(fondo_src).convert('RGB')
    # recorte centrado a 1024×500 manteniendo proporción, más oscuro y apenas desenfocado para que el título lea
    escala = max(W / f.width, H / f.height)
    f = f.resize((round(f.width * escala), round(f.height * escala)), Image.LANCZOS)
    x0 = (f.width - W) // 2; y0 = (f.height - H) // 2
    f = f.crop((x0, y0, x0 + W, y0 + H)).filter(ImageFilter.GaussianBlur(1.2))
    velo = Image.new('RGB', (W, H), FONDO)
    img = Image.blend(f, velo, 0.55)
    # degradé hacia el negro abajo, donde va el texto
    grad = Image.linear_gradient('L').resize((W, H)).rotate(180)
    img = Image.composite(img, velo, grad.point(lambda v: 255 - int(v * 0.85)))
d = ImageDraw.Draw(img)
titulo = 'CARRONA'; ft = fuente(118); tr = 34
tw = ancho(d, titulo, ft, tr)
espaciado(d, ((W - tw) / 2, 128), titulo, ft, CREMA, tr)
sub = 'un lugarcito · muchos zombis'; fs_ = fuente(24); trs = 7
sw = ancho(d, sub, fs_, trs)
espaciado(d, ((W - sw) / 2, 292), sub, fs_, GRIS, trs)
linea = '104 ARMAS  ·  RAGDOLL FÍSICO  ·  5 LUGARES  ·  SIN INTERNET'; fl = fuente(15); trl = 3
lw = ancho(d, linea, fl, trl)
espaciado(d, ((W - lw) / 2, 372), linea, fl, AMBAR, trl)
d.line([(W / 2 - 120, 352), (W / 2 + 120, 352)], fill=(58, 61, 72), width=1)
img.save(os.path.join(STORE, 'feature-graphic.png'), optimize=True)

# ── capturas: 24 bits y proporción ────────────────────────────────────────────
malas = []
for f in sorted(glob.glob(os.path.join(STORE, 'screenshots', 'phone', '*.png'))):
    im = Image.open(f)
    if im.mode != 'RGB': im.convert('RGB').save(f, optimize=True); im = Image.open(f)
    w, h = im.size
    if max(w, h) / min(w, h) > 2 or min(w, h) < 320 or max(w, h) > 3840: malas.append((os.path.basename(f), im.size))
n = len(glob.glob(os.path.join(STORE, 'screenshots', 'phone', '*.png')))
print(f"  icon-512.png {icono.size} · feature-graphic.png {img.size} · capturas {n} (24 bits) · fuera de norma: {malas or 'ninguna'}")
