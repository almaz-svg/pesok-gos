import math
from django.core.exceptions import ValidationError

def validate_geometry(value):
    if value is None:
        return
    try:
        if not isinstance(value, dict) or set(value) != {'type', 'coordinates'}:
            raise ValueError
        if value['type'] == 'Polygon':
            polygons = [value['coordinates']]
        elif value['type'] == 'MultiPolygon':
            polygons = value['coordinates']
        else:
            raise ValueError
        if not isinstance(polygons, list) or not polygons:
            raise ValueError
        for polygon in polygons:
            if not isinstance(polygon, list) or not polygon:
                raise ValueError
            for ring in polygon:
                if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                    raise ValueError
                for point in ring:
                    if not isinstance(point, list) or len(point) != 2:
                        raise ValueError
                    for n, bound in zip(point, (180, 90)):
                        if isinstance(n, bool) or not isinstance(n, (float, int)) or not math.isfinite(n) or abs(n) > bound:
                            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise ValidationError('Ожидается корректный Polygon/MultiPolygon WGS84 с замкнутыми кольцами.')

def geometry_in_bbox(geometry, bbox):
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    points = [point for polygon in polygons for ring in polygon for point in ring]
    west, south, east, north = bbox
    return (max(p[0] for p in points) >= west and min(p[0] for p in points) <= east
            and max(p[1] for p in points) >= south and min(p[1] for p in points) <= north)
