"""Private Windows credential bootstrap. No account/browser password is stored."""
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent / '.local' / 'browser'
KEY = ROOT / 'worker-key.dpapi'


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def crypt(data, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('Windows DPAPI is required')
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    api = ctypes.WinDLL('crypt32', use_last_error=True)
    function = api.CryptUnprotectData if decrypt else api.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        kernel.LocalFree(target.data)


if sys.argv[1:] == ['init']:
    ROOT.mkdir(parents=True, exist_ok=True)
    identity = subprocess.check_output(['whoami.exe'], text=True).strip()
    subprocess.run(['icacls.exe', str(ROOT), '/inheritance:r', '/grant:r',
                    f'{identity}:(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], check=True, capture_output=True)
    if KEY.exists():
        raise RuntimeError('Worker already configured; existing key left unchanged')
    token = secrets.token_urlsafe(32).encode('ascii')
    with KEY.open('xb') as output:
        output.write(crypt(token))
    config = {'baseUrl': 'https://line-webhook-xiju.vercel.app', 'workerId': str(uuid.uuid4())}
    (ROOT / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    print(json.dumps({'configured': True, 'workerId': config['workerId'], 'keySha256': hashlib.sha256(token).hexdigest()}))
elif sys.argv[1:] == ['read']:
    sys.stdout.write(crypt(KEY.read_bytes(), decrypt=True).decode('ascii'))
else:
    raise RuntimeError('Use init or read (read is for the private Node subprocess only)')
