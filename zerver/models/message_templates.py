from typing import Any

from django.conf import settings
from django.db import models
from django.utils.timezone import now as timezone_now

from zerver.models.realms import Realm
from zerver.models.users import UserProfile


class MessageTemplate(models.Model):
    MAX_TITLE_LENGTH = 60

    realm = models.ForeignKey(Realm, on_delete=models.CASCADE)
    user_profile = models.ForeignKey(UserProfile, on_delete=models.CASCADE)
    title = models.TextField(max_length=MAX_TITLE_LENGTH, blank=True, default="")
    content = models.TextField(max_length=settings.MAX_MESSAGE_LENGTH)
    date_created = models.DateTimeField(default=timezone_now)
    date_updated = models.DateTimeField(auto_now=True)

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "date_created": int(self.date_created.timestamp()),
            "date_updated": int(self.date_updated.timestamp()),
        }

    class Meta:
        indexes = [
            models.Index(fields=["user_profile", "date_created"]),
        ]
