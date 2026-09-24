import getpass
import os

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from monitoring.models import User

class Command(BaseCommand):
    help = 'Create an inspector. Password: INSPECTOR_PASSWORD env or interactive prompt; never command-line arguments.'

    def add_arguments(self, parser):
        parser.add_argument('--username', required=True)

    def handle(self, *args, **options):
        username = options['username']
        if User.objects.filter(username=username).exists():
            raise CommandError('User already exists; password was not changed.')
        password = os.getenv('INSPECTOR_PASSWORD') or getpass.getpass('Inspector password: ')
        user = User(username=username, is_inspector=True)
        try:
            validate_password(password, user)
            user.set_password(password)
            user.full_clean()
        except ValidationError as exc:
            raise CommandError('; '.join(exc.messages))
        user.save()
        self.stdout.write(self.style.SUCCESS(f'Inspector {username} created.'))
