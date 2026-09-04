# Servidor local mínimo para CARRONA (los módulos ES no cargan desde file://).
import http.server, socketserver, sys, os, webbrowser, threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
    url = f'http://127.0.0.1:{PORT}/'
    if '--no-open' not in sys.argv:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    print(f'CARRONA en {url}  (Ctrl+C para cerrar)')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
