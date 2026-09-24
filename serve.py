# Servidor local mínimo para CARRONA (los módulos ES no cargan desde file://).
#   python serve.py [puerto] [--dir carpeta] [--no-open]
# Enlaza a localhost (el mismo origen que usa el lanzador de Windows: localStorage
# es por origen, así que los récords y ajustes se comparten). Responde /__carrona
# con la versión, igual que el lanzador, para que el juego detecte el servidor.
import http.server, sys, os, json, re, webbrowser, threading
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
PORT = 8765
DIR = HERE
if '--dir' in argv:
    i = argv.index('--dir')
    DIR = os.path.abspath(argv[i + 1])
    del argv[i:i + 2]
for a in argv:
    if a.isdigit():
        PORT = int(a)

def version():
    # la meta que inyecta el build (dist/index.html) o, en el repo, package.json
    try:
        with open(os.path.join(DIR, 'index.html'), encoding='utf-8') as f:
            m = re.search(r'name="carrona-build"\s+content="([^"]+)"', f.read())
            if m:
                return m.group(1)
    except OSError:
        pass
    try:
        with open(os.path.join(HERE, 'package.json'), encoding='utf-8') as f:
            return json.load(f).get('version', 'dev')
    except (OSError, ValueError):
        return 'dev'

VERSION = version()

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
    }
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass
    def _text(self, code, body, ctype='application/json'):
        data = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)
    def do_GET(self):
        if self.path.split('?')[0] == '/__carrona':
            return self._text(200, json.dumps({'app': 'carrona', 'version': VERSION, 'port': PORT}))
        super().do_GET()
    def do_POST(self):
        # el juego avisa que se cerró (navigator.sendBeacon); el servidor de desarrollo sigue vivo
        if self.path.split('?')[0] == '/__bye':
            return self._text(204, '', 'text/plain')
        self._text(405, 'solo GET', 'text/plain; charset=utf-8')

http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('localhost', PORT), partial(H, directory=DIR)) as httpd:
    url = f'http://localhost:{PORT}/'
    if '--no-open' not in argv:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    print(f'CARRONA {VERSION} en {url}  sirviendo {DIR}  (Ctrl+C para cerrar)')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
