"""Bundle original receipt images without re-encoding them; verify downloaded ZIPs."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif'}
MAX_ZIP = 10 * 1024 * 1024
MAX_ORIGINALS = 100 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_scope(scope):
    if not re.fullmatch(r'\d+', str(scope.get('companyId', ''))) or not re.fullmatch(r'\d+', str(scope.get('recordId', ''))):
        raise ValueError('Missing company/document identity')
    if not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', scope.get('month', '')) or scope.get('bucket') not in {'online', 'petty_cash', 'electricity'}:
        raise ValueError('Invalid monthly group')
    if not re.fullmatch(r'EXP\d{10}', scope.get('serial', '')):
        raise ValueError('Missing saved document serial')


def verify(archive_path, expected):
    data = Path(archive_path).read_bytes()
    if len(data) != expected['bytes'] or sha(data) != expected['sha256'] or len(data) > MAX_ZIP:
        raise ValueError('Downloaded ZIP bytes do not match the prepared archive')
    manifest = expected['manifest']
    entries = manifest['entries']
    with zipfile.ZipFile(archive_path) as bundle:
        names = bundle.namelist()
        wanted = ['manifest.json'] + [entry['name'] for entry in entries]
        if len(names) != len(set(names)) or set(names) != set(wanted):
            raise ValueError('ZIP members differ from the manifest')
        if any(PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or '\\' in name for name in names):
            raise ValueError('Unsafe ZIP member path')
        if sum(info.file_size for info in bundle.infolist()) > MAX_ORIGINALS + 1024 * 1024:
            raise ValueError('ZIP expands beyond the original image budget')
        if json.loads(bundle.read('manifest.json')) != manifest:
            raise ValueError('Embedded ZIP manifest does not match')
        for entry in entries:
            image = bundle.read(entry['name'])
            if len(image) != entry['bytes'] or sha(image) != entry['sha256']:
                raise ValueError('An original image is missing or changed')
    return {'verified': True, 'filename': expected['filename'], 'sha256': expected['sha256'], 'imageCount': len(entries)}


def build(spec, output_dir):
    scope, sources, inventory = spec['scope'], spec['files'], spec['inventory']
    validate_scope(scope)
    if spec.get('limitObserved') is not True or spec.get('limitReason') not in {'image_count_limit', 'attachment_count_limit'} or not str(spec.get('limitMessage', '')).strip():
        raise ValueError('ZIP fallback requires an observed attachment limit')
    if not isinstance(inventory, list) or len(inventory) != len(set(inventory)):
        raise ValueError('Ambiguous image inventory; resolve duplicate attachment names first')
    if len(sources) != len(inventory) + 1 or len(sources) > 1001:
        raise ValueError('All existing document images and the current original are required')
    entries, originals, existing, current = [], [], [], []
    total = 0
    for index, source in enumerate(sources, 1):
        file = Path(source['path'])
        source_name = source['sourceName']
        suffix = Path(source_name).suffix.lower()
        if suffix not in EXTENSIONS or any(c in source_name for c in ['/', '\\', '\x00']) or file.suffix.lower() not in EXTENSIONS:
            raise ValueError('Only original image files may enter the archive')
        if source['source'] == 'current':
            current.append(source_name)
        elif source['source'] == 'existing' and source_name in inventory:
            existing.append(source_name)
        else:
            raise ValueError('Image is outside the document inventory')
        data = file.read_bytes()
        total += len(data)
        if not data or total > MAX_ORIGINALS:
            raise ValueError('Missing image or original image set exceeds the archive budget')
        digest = sha(data)
        entry = {'name': f'images/{index:04d}-{digest[:12]}{suffix}', 'sourceName': source_name,
                 'source': source['source'], 'sha256': digest, 'bytes': len(data)}
        entries.append(entry)
        originals.append(data)
    if len(current) != 1 or sorted(existing) != sorted(inventory):
        raise ValueError('Not all document originals were supplied exactly once')
    manifest = {'version': 1, 'scope': scope, 'entries': entries}
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    pending = output / 'receipt-archive-building.tmp'
    with zipfile.ZipFile(pending, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
        for entry, data in zip(entries, originals):
            bundle.writestr(entry['name'], data)
    archive_bytes = pending.read_bytes()
    digest = sha(archive_bytes)
    if len(archive_bytes) > MAX_ZIP:
        pending.unlink()
        raise ValueError('ZIP exceeds 10 MiB; originals were kept. Do not drop images to make it fit')
    filename = f"line-{scope['month']}-{scope['bucket']}-{digest[:12]}.zip"
    target = output / filename
    pending.replace(target)
    result = {'filename': filename, 'sha256': digest, 'bytes': len(archive_bytes), 'manifest': manifest,
              'inventory': inventory, 'limitObserved': True, 'limitReason': spec['limitReason'], 'limitMessage': spec['limitMessage'][:500]}
    verify(target, result)
    return {'path': str(target.resolve()), 'archive': result}


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in {'build', 'verify'}:
        raise ValueError('Use build SPEC.json OUTPUT_DIR or verify ZIP EXPECTED.json')
    if sys.argv[1] == 'build':
        result = build(json.loads(Path(sys.argv[2]).read_text(encoding='utf-8-sig')), sys.argv[3])
    else:
        result = verify(sys.argv[2], json.loads(Path(sys.argv[3]).read_text(encoding='utf-8-sig')))
    print(json.dumps(result, ensure_ascii=False))
