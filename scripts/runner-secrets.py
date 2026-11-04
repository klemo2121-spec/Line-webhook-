"""Store the independent worker's API key under Windows CurrentUser DPAPI."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys

class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def protect(data, decrypt=False):
    buf=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)))
    target=Blob()
    api=ctypes.WinDLL('crypt32',use_last_error=True)
    fn=api.CryptUnprotectData if decrypt else api.CryptProtectData
    if not fn(ctypes.byref(source),None,None,None,None,1,ctypes.byref(target)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:return ctypes.string_at(target.data,target.size)
    finally:
        free=ctypes.WinDLL('kernel32').LocalFree
        free.argtypes=[ctypes.c_void_p];free(ctypes.cast(target.data,ctypes.c_void_p))

if __name__=='__main__':
    target=Path(__file__).resolve().parent.parent/'.local/browser/runner-key.dpapi'
    if sys.argv[1:] == ['write']:
        value=json.load(sys.stdin)
        if not value.get('apiKey','').startswith('sk-'):raise ValueError('Missing API key')
        target.write_bytes(protect(json.dumps(value).encode()))
        print('{"stored":true}')
    elif sys.argv[1:] == ['read']:
        sys.stdout.write(protect(target.read_bytes(),True).decode())
    else:raise ValueError('Use write or read')
