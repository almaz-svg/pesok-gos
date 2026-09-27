import math
from collections.abc import Mapping
from datetime import timezone as utc

from django.db import models
from django.core.validators import RegexValidator
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

    def validate_telegram_file_id(self, value):
        if value.startswith('demo-photo:'):
            raise serializers.ValidationError('Ожидается Telegram file_id, демонстрационные значения запрещены')
        return value

class BotTextField(serializers.CharField):
    """Bot output is bounded plain text, not a number coerced to text or rendered HTML."""
    def __init__(self, **kwargs):
        kwargs.setdefault('required', False)
        kwargs.setdefault('allow_blank', True)
        super().__init__(trim_whitespace=False, **kwargs)

    def to_internal_value(self, data):
        if not isinstance(data, str):
            raise serializers.ValidationError('Ожидается строка')
        return super().to_internal_value(data)

class BotDaysField(serializers.IntegerField):
    def to_internal_value(self, data):
        if isinstance(data, bool) or not isinstance(data, int):
            raise serializers.ValidationError('Ожидается целое число')
        return super().to_internal_value(data)

class CasePassportInput(StrictSerializer):
    type = BotTextField(max_length=80)
    typeLabel = BotTextField(max_length=160)
    responsibleAuthority = BotTextField(max_length=500)
    urgency = serializers.ChoiceField(choices=['high', 'normal'], required=False)
    evidenceChecklist = serializers.ListField(child=BotTextField(max_length=500), max_length=20, required=False)
    officialDraft = BotTextField(max_length=12000)
    followUpDraft = BotTextField(max_length=12000)
    inactivityComplaintDraft = BotTextField(max_length=12000)
    publicText = BotTextField(max_length=8000)
    socialText = BotTextField(max_length=4000)
    nextAction = BotTextField(max_length=1000)
    followUpDays = BotDaysField(min_value=1, max_value=365, required=False)

class BotResultInput(StrictSerializer):
    language = serializers.ChoiceField(choices=['ru', 'kk', 'en'], required=False)
    location_summary = BotTextField(max_length=4000)
    land_case_id = BotTextField(allow_blank=False, min_length=12, max_length=12,
                               validators=[RegexValidator(r'\A[0-9a-fA-F]{12}\Z')])
    case_passport = CasePassportInput(required=False)

class CreateReportSerializer(StrictSerializer):
    telegram_user_id = TelegramUserField()
    location = LocationInput()
    photos = PhotoInput(many=True, min_length=1, max_length=3)
    description = serializers.CharField(min_length=10, max_length=3000)
    category = serializers.ChoiceField(choices=Category.choices)
    bot_result = BotResultInput(required=False, allow_null=True)

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
        fields = ReportSerializer.Meta.fields + ['history', 'bot_result']

class BotPhotoSerializer(PhotoSerializer):
    class Meta(PhotoSerializer.Meta):
        fields = PhotoSerializer.Meta.fields + ['telegram_file_id']

class BotReportSerializer(ReportSerializer):
    telegram_user_id = serializers.CharField(source='tracking.owner_telegram_user_id')
    photos = BotPhotoSerializer(many=True)

    class Meta(ReportSerializer.Meta):
        fields = ReportSerializer.Meta.fields + ['bot_result', 'telegram_user_id']

class InstructionSerializer(UTCModelSerializer):
    class Meta:
        model = Instruction
        fields = ['id', 'title', 'body', 'updated_at']

class LoginSerializer(StrictSerializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(trim_whitespace=False, max_length=4096, write_only=True)

class TrackingQuerySerializer(StrictSerializer):
    telegram_user_id = TelegramUserField()

class BotReportsQuery(TrackingQuerySerializer):
    page = serializers.IntegerField(min_value=1, required=False, default=1)
    page_size = serializers.IntegerField(min_value=1, max_value=100, required=False, default=20)

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
