from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('monitoring', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='report',
            name='bot_result',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
