"""Loopback startup and HTTP serving must work without DNS or mDNS."""
import http.client
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import LocalHTTPServer


class QuietHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        pass


class LoopbackStartupTests(unittest.TestCase):
    def test_serves_http_without_reverse_dns(self):
        with patch("socket.getfqdn", side_effect=AssertionError("Offline startup invoked DNS")) as lookup:
            service = LocalHTTPServer(("127.0.0.1", 0), QuietHandler)
            worker = threading.Thread(target=service.serve_forever, daemon=True)
            worker.start()
            try:
                self.assertEqual(service.server_name, "localhost")
                self.assertGreater(service.server_port, 0)
                client = http.client.HTTPConnection("127.0.0.1", service.server_port, timeout=5)
                try:
                    client.request("GET", "/")
                    self.assertEqual(client.getresponse().status, 204)
                finally:
                    client.close()
                lookup.assert_not_called()
            finally:
                service.shutdown()
                worker.join(timeout=5)
                service.server_close()
            self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main(verbosity=2)
