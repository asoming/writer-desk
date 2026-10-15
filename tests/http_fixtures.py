"""DNS-free HTTP wrappers for disposable test fixtures, never production servers."""
from http.server import ThreadingHTTPServer
from socketserver import TCPServer


class LoopbackHTTPServer(ThreadingHTTPServer):
    """Bind test providers directly without HTTPServer's reverse-DNS lookup."""

    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]
