import json


def encode_message(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")


def decode_lines(buffer):
    messages = []
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        if line.strip():
            messages.append(json.loads(line.decode("utf-8")))
    return messages, buffer
