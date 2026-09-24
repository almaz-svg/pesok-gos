import uuid
from datetime import timezone as dt_timezone

from django.contrib.auth.models import AbstractUser
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from .validators import validate_geometry

class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    is_inspector = models.BooleanField(default=False)

class ReportStatus(models.TextChoices):
    NEW = 'NEW', 'Новое'
    INSPECTION = 'INSPECTION', 'На проверке'
    VIOLATION = 'VIOLATION', 'Нарушение подтверждено'
    IN_PROGRESS = 'IN_PROGRESS', 'Устраняется'
    RESOLVED = 'RESOLVED', 'Закрыто'

class Category(models.TextChoices):
    DUMPING = 'DUMPING', 'Свалка'
    LAND_GRAB = 'LAND_GRAB', 'Самозахват'
    UNUSED_LAND = 'UNUSED_LAND', 'Неиспользуемая земля'
    ABANDONED_PLOT = 'ABANDONED_PLOT', 'Заброшенный участок'
    OTHER = 'OTHER', 'Другое'

TRANSITIONS = {
    'NEW': {'INSPECTION'}, 'INSPECTION': {'VIOLATION', 'RESOLVED'},
    'VIOLATION': {'IN_PROGRESS'}, 'IN_PROGRESS': {'RESOLVED'}, 'RESOLVED': set(),
}

class LandPlot(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    cadastral_number = models.CharField(max_length=100, unique=True)
    area_ha = models.DecimalField(max_digits=14, decimal_places=4, validators=[MinValueValidator(0.0001)])
    purpose = models.CharField(max_length=500)
    address = models.CharField(max_length=500, null=True, blank=True)
    geometry = models.JSONField(null=True, blank=True, validators=[validate_geometry])

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(area_ha__gt=0), name='plot_positive_area')]

class TrackingSequence(models.Model):
    """BigAutoField uses a PostgreSQL sequence; never allocate with count()+1."""
    id = models.BigAutoField(primary_key=True)

class TrackingRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    number = models.CharField(max_length=40, unique=True)
    owner_telegram_user_id = models.BigIntegerField(validators=[MinValueValidator(1)])

    @classmethod
    def allocate(cls, owner):
        value = TrackingSequence.objects.create().pk
        year = timezone.now().astimezone(dt_timezone.utc).year
        return cls.objects.create(number=f'KZ-{year}-{value:06d}', owner_telegram_user_id=owner)

class Report(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tracking = models.OneToOneField(TrackingRecord, on_delete=models.PROTECT, related_name='report')
    category = models.CharField(max_length=30, choices=Category.choices, db_index=True)
    description = models.TextField()
    latitude = models.FloatField(validators=[MinValueValidator(-90), MaxValueValidator(90)])
    longitude = models.FloatField(validators=[MinValueValidator(-180), MaxValueValidator(180)])
    plot = models.ForeignKey(LandPlot, null=True, blank=True, on_delete=models.SET_NULL, related_name='reports')
    status = models.CharField(max_length=20, choices=ReportStatus.choices, default=ReportStatus.NEW)
    deadline = models.DateField(null=True, blank=True, db_index=True)
    version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=['status', 'created_at'])]
        constraints = [
            models.CheckConstraint(condition=models.Q(latitude__gte=-90, latitude__lte=90), name='report_latitude_range'),
            models.CheckConstraint(condition=models.Q(longitude__gte=-180, longitude__lte=180), name='report_longitude_range'),
            models.CheckConstraint(condition=models.Q(version__gte=1), name='report_positive_version'),
        ]

    @property
    def is_overdue(self):
        return bool(self.deadline and self.deadline < timezone.localdate() and self.status != ReportStatus.RESOLVED)

class ReportPhoto(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    report = models.ForeignKey(Report, on_delete=models.CASCADE, related_name='photos')
    telegram_file_id = models.CharField(max_length=1024)
    ordinal = models.PositiveSmallIntegerField()

    class Meta:
        ordering = ['ordinal']
        constraints = [models.UniqueConstraint(fields=['report', 'ordinal'], name='photo_report_ordinal')]

class StatusHistory(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    report = models.ForeignKey(Report, on_delete=models.CASCADE, related_name='history')
    event = models.CharField(max_length=10, choices=[('CREATED', 'Created'), ('UPDATED', 'Updated')])
    before = models.JSONField(null=True)
    after = models.JSONField()
    comment = models.TextField(null=True)
    actor_user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    actor_type = models.CharField(max_length=12)
    actor_label = models.CharField(max_length=150)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at', 'id']
        indexes = [models.Index(fields=['report', 'created_at', 'id'])]

class ApplicationStatus(models.TextChoices):
    RECEIVED = 'RECEIVED', 'Заявление принято'
    IN_REVIEW = 'IN_REVIEW', 'На рассмотрении'
    INSPECTION_SCHEDULED = 'INSPECTION_SCHEDULED', 'Назначен выезд инспектора'
    COMPLETED = 'COMPLETED', 'Завершено'
    REJECTED = 'REJECTED', 'Отклонено'

class Application(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tracking = models.OneToOneField(TrackingRecord, on_delete=models.PROTECT, related_name='application')
    status = models.CharField(max_length=30, choices=ApplicationStatus.choices, default=ApplicationStatus.RECEIVED)
    deadline = models.DateField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

class ApplicationHistory(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    application = models.ForeignKey(Application, on_delete=models.CASCADE, related_name='history')
    status = models.CharField(max_length=30, choices=ApplicationStatus.choices)
    label = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at', 'id']

class Instruction(models.Model):
    id = models.SlugField(primary_key=True)
    title = models.CharField(max_length=200)
    body = models.TextField()
    sort_order = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['sort_order', 'id']

class IdempotencyRecord(models.Model):
    service = models.CharField(max_length=30)
    key = models.UUIDField()
    payload_hash = models.CharField(max_length=64)
    response = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['service', 'key'], name='idempotency_service_key')]
