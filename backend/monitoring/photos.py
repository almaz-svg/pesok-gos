import io
import re
import warnings

import requests
from django.conf import settings
from PIL import Image, ImageDraw, UnidentifiedImageError

from .errors import ApiProblem

DEMO_PHOTO_FILE_ID = 'demo-photo:seed-v1'

def demo_photo():
    """A clearly labeled local sample, never presented as Telegram evidence."""
    image = Image.new('RGB', (640, 360), '#e2e8dc')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 639, 58), fill='#173527')
    draw.text((24, 20), 'DEMO PHOTO / SAMPLE ONLY', fill='white')
    draw.polygon([(0, 240), (200, 180), (430, 225), (640, 165), (640, 359), (0, 359)], fill='#a9b69e')
    draw.rectangle((105, 165, 360, 260), outline='#bd533f', width=5)
    draw.line((105, 165, 360, 260), fill='#bd533f', width=3)
    draw.line((105, 260, 360, 165), fill='#bd533f', width=3)
    draw.rectangle((0, 316, 639, 359), fill='#173527')
    draw.text((24, 332), 'Fictional location. No real violation shown.', fill='white')
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue(), 'image/png'

def fetch_photo(file_id):
    if file_id == DEMO_PHOTO_FILE_ID:
        return demo_photo()
    try:
        if not settings.BOT_TOKEN:
            raise ValueError
        # Never expose these URLs to the client or include them in logs.
        with requests.get(f'https://api.telegram.org/bot{settings.BOT_TOKEN}/getFile',
                          params={'file_id': file_id}, timeout=(3, 10), allow_redirects=False) as response:
            if response.status_code != 200:
                raise ValueError
            payload = response.json()
        result = payload['result']
        path = result['file_path']
        if (not payload.get('ok') or not isinstance(path, str)
                or not re.fullmatch(r'[A-Za-z0-9_/-]+\.[A-Za-z0-9]+', path)
                or path.startswith('/') or '..' in path or result.get('file_size', 0) > settings.PHOTO_MAX_BYTES):
            raise ValueError
        with requests.get(f'https://api.telegram.org/file/bot{settings.BOT_TOKEN}/{path}',
                          timeout=(3, 10), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                raise ValueError
            content = bytearray()
            for chunk in response.iter_content(64 * 1024):
                content.extend(chunk)
                if len(content) > settings.PHOTO_MAX_BYTES:
                    raise ValueError
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                mime = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}.get(image.format)
                if not mime:
                    raise ValueError
                image.verify()
        return bytes(content), mime
    except (requests.RequestException, ValueError, KeyError, TypeError, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ApiProblem('photo_unavailable', 'Фото временно недоступно', 502) from None
