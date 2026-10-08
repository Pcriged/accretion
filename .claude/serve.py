"""Static dev server for the visualizer. Sends no-store so edits show up on reload."""
import http.server
import os
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
http.server.test(HandlerClass=NoCacheHandler, port=int(os.environ.get("PORT", "8765")), bind="127.0.0.1")
