import math
from collections.abc import Mapping
from datetime import timezone as utc

from django.db import models
from rest_framework import serializers

from .models import Category, Instruction, LandPlot, Report, ReportPhoto, ReportStatus, StatusHistory

class UTCDateTimeField(serializers.DateTimeField):
    def __init__(self, **kwargs):
        super().__init__(default_timezone=utc.utc, **kwargs)

class UTCModelSerializer(serializers.ModelSerializer):
    serializer_field_mapping = {**serializers.ModelSerializer.serializer_field_mapping, models.DateTimeField: UTCDateTimeField}

class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if isinstance(data, Mapping):
            unknown = set(data) - set(self.fields)
            if unknown:
                raise serializers.ValidationError({key: ['Неизвестное поле'] for key in sorted(unknown)})
        return super().to_internal_value(data)

class TelegramUserField(serializers.CharField):
    def to_internal_value(self, data):
        if not isinstance(data, str) or not data.isascii() or not data.isdigit():
            raise serializers.ValidationError('Ожидается положительная десятичная строка')
        if len(data) > 19 or not 0 < int(data) <= 9223372036854775807:
            raise serializers.ValidationError('ID вне допустимого диапазона')
        return str(int(data))

class CoordinateField(serializers.FloatField):
    def to_internal_value(self, data):
        if isinstance(data, bool) or not isinstance(data, (int, float)) or not math.isfinite(data):
            raise serializers.ValidationError('Ожидается конечное число')
        return super().to_internal_value(data)

class LocationInput(StrictSerializer):
    latitude = CoordinateField(min_value=-90, max_value=90)
    longitude = CoordinateField(min_value=-180, max_value=180)

class PhotoInput(StrictSerializer):
    telegram_file_id = serializers.CharField(max_length=1024)

class CreateReportSerializer(StrictSerializer):
    telegram_user_id = TelegramUserField()
    location = LocationInput()
    photos = PhotoInput(many=True, min_length=1, max_length=3)
    description = serializers.CharField(min_length=10, max_length=3000)
    category = serializers.ChoiceField(choices=Category.choices)

    def validate_photos(self, value):
        if len({photo['telegram_file_id'] for photo in value}) != len(value):
            raise serializers.ValidationError('Фотографии не должны повторяться')
        return value

class PatchReportSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=1)
    status = serializers.ChoiceField(choices=ReportStatus.choices, required=False)
    deadline = serializers.DateField(required=False, allow_null=True, input_formats=['%Y-%m-%d'])
    plot_id = serializers.PrimaryKeyRelatedField(queryset=LandPlot.objects.all(), pk_field=serializers.UUIDField(), required=False, allow_null=True)
    comment = serializers.CharField(min_length=1, max_length=2000, required=False)

    def validate(self, value):
        if len(value) == 1:
            raise serializers.ValidationError('Нужно указать хотя бы одно изменение')
        return value

class PhotoSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    def get_url(self, obj):
        return f'/api/photos/{obj.id}'

    class Meta:
        model = ReportPhoto
        fields = ['id', 'url']

class PlotRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = LandPlot
        fields = ['id', 'cadastral_number']

class PlotSerializer(serializers.ModelSerializer):
    area_ha = serializers.FloatField()
    status = serializers.CharField(source='computed_status')
    active_reports_count = serializers.IntegerField()

    class Meta:
        model = LandPlot
        fields = ['id', 'cadastral_number', 'area_ha', 'purpose', 'address', 'status', 'geometry', 'active_reports_count']

class ReportSerializer(UTCModelSerializer):
    tracking_number = serializers.CharField(source='tracking.number')
    location = serializers.SerializerMethodField()
    plot = PlotRefSerializer(allow_null=True)
    photos = PhotoSerializer(many=True)
    is_overdue = serializers.BooleanField()

    def get_location(self, obj):
        return {'latitude': obj.latitude, 'longitude': obj.longitude}

    class Meta:
        model = Report
        fields = ['id', 'tracking_number', 'category', 'description', 'location', 'plot', 'status',
                  'deadline', 'is_overdue', 'photos', 'version', 'created_at', 'updated_at']

class HistorySerializer(UTCModelSerializer):
    actor = serializers.SerializerMethodField()

    def get_actor(self, obj):
        return {'type': obj.actor_type, 'label': obj.actor_label}

    class Meta:
        model = StatusHistory
        fields = ['id', 'event', 'before', 'after', 'comment', 'actor', 'created_at']

class ReportDetailSerializer(ReportSerializer):
    history = HistorySerializer(many=True)

    class Meta(ReportSerializer.Meta):
        fields = ReportSerializer.Meta.fields + ['history']

class InstructionSerializer(UTCModelSerializer):
    class Meta:
        model = Instruction
        fields = ['id', 'title', 'body', 'updated_at']

class LoginSerializer(StrictSerializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(trim_whitespace=False, max_length=4096, write_only=True)

class TrackingQuerySerializer(StrictSerializer):
    telegram_user_id = TelegramUserField()

class StrictBool(serializers.Field):
    def to_internal_value(self, data):
        if data not in ('true', 'false'):
            raise serializers.ValidationError('Ожидается true или false')
        return data == 'true'

class BboxField(serializers.Field):
    def to_internal_value(self, data):
        try:
            values = [float(value) for value in data.split(',')]
            west, south, east, north = values
            if not all(math.isfinite(n) for n in values) or not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
                raise ValueError
            return values
        except (ValueError, AttributeError):
            raise serializers.ValidationError('Ожидается bbox=west,south,east,north')

class ReportQuery(StrictSerializer):
    status = serializers.ChoiceField(choices=ReportStatus.choices, required=False)
    category = serializers.ChoiceField(choices=Category.choices, required=False)
    overdue = StrictBool(required=False)
    plot_id = serializers.UUIDField(required=False)
    search = serializers.CharField(max_length=100, allow_blank=True, required=False)
    page = serializers.IntegerField(min_value=1, required=False, default=1)
    page_size = serializers.IntegerField(min_value=1, max_value=100, required=False, default=20)

class PlotQuery(StrictSerializer):
    status = serializers.ChoiceField(choices=['NORMAL', 'INSPECTION', 'VIOLATION'], required=False)
    search = serializers.CharField(max_length=100, allow_blank=True, required=False)
    page = serializers.IntegerField(min_value=1, required=False, default=1)
    page_size = serializers.IntegerField(min_value=1, max_value=100, required=False, default=20)

class MapQuery(StrictSerializer):
    bbox = BboxField(required=False)
    report_status = serializers.ChoiceField(choices=ReportStatus.choices, required=False)
    plot_status = serializers.ChoiceField(choices=['NORMAL', 'INSPECTION', 'VIOLATION'], required=False)
    category = serializers.ChoiceField(choices=Category.choices, required=False)
    overdue = StrictBool(required=False)
    search = serializers.CharField(max_length=100, allow_blank=True, required=False)

def validate_query(request, serializer_class):
    if any(len(request.query_params.getlist(key)) != 1 for key in request.query_params):
        raise serializers.ValidationError('Параметр нельзя передавать несколько раз')
    serializer = serializer_class(data=request.query_params.dict())
    serializer.is_valid(raise_exception=True)
    return serializer.validated_data
