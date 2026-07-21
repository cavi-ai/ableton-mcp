import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from protocol import decode_lines, encode_message


class ProtocolTest(unittest.TestCase):
    def test_partial_and_multiple_frames(self):
        first = encode_message({"id": "1"})
        messages, remainder = decode_lines(first[:-1])
        self.assertEqual(messages, [])
        messages, remainder = decode_lines(remainder + first[-1:] + encode_message({"id": "2"}))
        self.assertEqual([message["id"] for message in messages], ["1", "2"])
        self.assertEqual(remainder, b"")


if __name__ == "__main__":
    unittest.main()
