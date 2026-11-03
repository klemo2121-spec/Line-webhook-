import importlib.util
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location('verify_image', Path(__file__).parents[1] / 'scripts/verify-receipt-image.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReceiptImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.original = Path(self.temp.name) / 'original.jpg'
        self.saved = Path(self.temp.name) / 'saved.jpg'
        image = Image.new('RGB', (400, 500), 'white')
        draw = ImageDraw.Draw(image)
        draw.text((40, 80), 'DEMO SUPPLIER 42.00 THB\n02-11-2026\nInvoice TEST-1234', fill='black')
        image.save(self.original, quality=95)

    def test_identical_bytes(self):
        self.saved.write_bytes(self.original.read_bytes())
        self.assertEqual(module.verify(self.original, self.saved)['method'], 'bytes')

    def test_exact_service_jpeg_reencoding(self):
        Image.open(self.original).save(self.saved, quality=91)
        self.assertEqual(module.verify(self.original, self.saved)['method'], 'exact_jpeg_reencode')

    def test_changed_amount_is_rejected(self):
        image = Image.open(self.original)
        ImageDraw.Draw(image).text((40, 80), '9999.00', fill='red')
        image.save(self.saved, quality=91)
        with self.assertRaises(ValueError):
            module.verify(self.original, self.saved)

    def test_resize_is_rejected(self):
        Image.open(self.original).resize((200, 250)).save(self.saved, quality=91)
        with self.assertRaises(ValueError):
            module.verify(self.original, self.saved)

    def test_low_quality_is_rejected(self):
        Image.open(self.original).save(self.saved, quality=30)
        with self.assertRaises(ValueError):
            module.verify(self.original, self.saved)


if __name__ == '__main__':
    unittest.main()
