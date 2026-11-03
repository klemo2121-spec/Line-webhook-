import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('receipt_archive', Path(__file__).resolve().parents[1] / 'scripts' / 'receipt-archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ReceiptArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'old.jpg'
        self.new = self.root / 'new.png'
        self.old.write_bytes(b'\xff\xd8\xfforiginal jpeg bytes\xff\xd9')
        self.new.write_bytes(b'\x89PNG\r\n\x1a\noriginal png bytes')
        self.scope = {'companyId': '7', 'recordId': '222', 'serial': 'EXP2026110002', 'month': '2026-11', 'bucket': 'online'}
        self.input = {'scope': self.scope, 'limitObserved': True, 'limitReason': 'image_count_limit', 'limitMessage': 'Maximum image attachments reached', 'inventory': ['old.jpg'], 'files': [
            {'path': str(self.old), 'sourceName': 'old.jpg', 'source': 'existing'},
            {'path': str(self.new), 'sourceName': 'line-test.png', 'source': 'current'}]}

    def test_lossless_build_and_fresh_download_verification(self):
        built = archive.build(self.input, self.root / 'output')
        expected = built['archive']
        self.assertEqual(len(expected['manifest']['entries']), 2)
        self.assertEqual(expected['manifest']['entries'][0]['sha256'], archive.sha(self.old.read_bytes()))
        download = self.root / 'download.zip'
        download.write_bytes(Path(built['path']).read_bytes())
        self.assertTrue(archive.verify(download, expected)['verified'])

    def test_missing_originals_or_missing_limit_never_build_success(self):
        bad = copy.deepcopy(self.input)
        bad['inventory'].append('missing.jpg')
        with self.assertRaises(ValueError):
            archive.build(bad, self.root / 'output')
        bad = copy.deepcopy(self.input)
        bad['limitObserved'] = False
        with self.assertRaises(ValueError):
            archive.build(bad, self.root / 'output')
        bad['limitObserved'] = True
        bad['limitReason'] = 'network_error'
        with self.assertRaises(ValueError):
            archive.build(bad, self.root / 'output')

    def test_changed_download_or_manifest_cannot_verify(self):
        built = archive.build(self.input, self.root / 'output')
        original = Path(built['path']).read_bytes()
        bad_file = self.root / 'changed.zip'
        bad_file.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaises(ValueError):
            archive.verify(bad_file, built['archive'])
        expected = copy.deepcopy(built['archive'])
        expected['manifest']['scope']['month'] = '2026-10'
        with self.assertRaises(ValueError):
            archive.verify(built['path'], expected)

    def test_non_image_path_traversal_and_ambiguous_names_are_rejected(self):
        for name in ['../../private.jpg', 'passwords.txt', 'previous.zip']:
            bad = copy.deepcopy(self.input)
            bad['files'][0]['sourceName'] = name
            with self.assertRaises(ValueError):
                archive.build(bad, self.root / 'output')
        bad = copy.deepcopy(self.input)
        bad['inventory'] = ['old.jpg', 'old.jpg']
        with self.assertRaises(ValueError):
            archive.build(bad, self.root / 'output')


if __name__ == '__main__':
    unittest.main()
