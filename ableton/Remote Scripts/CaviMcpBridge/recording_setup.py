"""Document and stopped-transport evidence for native recording preparation."""
import os
import uuid
try:
    from .bridge import _transport_context, _set_fingerprint
except ImportError:
    from bridge import _transport_context, _set_fingerprint

_document = (None, None)


def source(song, params, version):
    global _document
    if _document[0] != song:
        _document = (song, str(uuid.uuid4()))
    path = str(song.file_path)
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _document[1],
            'filePath': path, 'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(path))[0]),
            'scriptDirectory': os.path.dirname(__file__), 'transport': _transport_context(song, version),
            'recording': {'arrangement': bool(song.record_mode), 'session': bool(song.session_record),
                          'countingIn': bool(getattr(song, 'is_counting_in', False))}}
