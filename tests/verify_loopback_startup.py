"""Loopback startup and HTTP serving must work without DNS or mDNS."""
import http.client
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import sys
import threading
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import LocalHTTPServer
from collaboration import start_hub


class QuietHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        pass


class LoopbackStartupTests(unittest.TestCase):
    def test_sync_hub_serves_local_and_lan_without_reverse_dns(self):
        for host in ("127.0.0.1", "0.0.0.0"):
            with self.subTest(host=host), tempfile.TemporaryDirectory() as directory:
                with patch("socket.getfqdn", side_effect=AssertionError("Sync startup invoked DNS")) as lookup:
                    service, worker = start_hub(str(Path(directory).resolve()), host, 0)
                    try:
                        self.assertGreater(service.server_port, 0)
                        client = http.client.HTTPConnection("127.0.0.1", service.server_port, timeout=5)
                        try:
                            client.request("GET", "/mobile/")
                            response = client.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertIn("作家工作台", response.read().decode("utf-8"))
                        finally:
                            client.close()
                        lookup.assert_not_called()
                    finally:
                        service.shutdown()
                        worker.join(timeout=5)
                        service.server_close()
                        service.store.close()
                    self.assertFalse(worker.is_alive())

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
