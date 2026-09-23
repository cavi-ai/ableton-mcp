import os
import re
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import bridge


class CapabilitiesTest(unittest.TestCase):
    def test_every_advertised_capability_dispatches(self):
        unsupported = []
        with patch.object(bridge, "_set_fingerprint", return_value="fixture"):
            for method in bridge.CAPABILITIES:
                try:
                    bridge.dispatch_request(SimpleNamespace(), {"method": method, "params": {}}, 0)
                except ValueError as error:
                    if str(error) == f"unsupported method {method}":
                        unsupported.append(method)
                except Exception:
                    pass
        self.assertEqual(unsupported, [])

    def test_every_dispatched_method_is_advertised(self):
        with open(bridge.__file__, encoding="utf-8") as source_file:
            source = source_file.read()
        handled = set(re.findall(r'method == "([a-z_]+)"', source))
        for group in re.findall(r"method in \(([^)]*)\)", source):
            handled.update(re.findall(r'"([a-z_]+)"', group))
        self.assertEqual(sorted(handled - set(bridge.CAPABILITIES)), [])


if __name__ == "__main__":
    unittest.main()
