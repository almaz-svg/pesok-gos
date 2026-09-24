import io
import re
import warnings

import requests
from django.conf import settings
from PIL import Image, UnidentifiedImageError

from .errors import ApiProblem

def fetch_photo(file_id):
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
