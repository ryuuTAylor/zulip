from zerver.lib.test_classes import ZulipTestCase
from zerver.models import MessageTemplate


class MessageTemplateModelTest(ZulipTestCase):
    def test_title_defaults_to_empty_string(self) -> None:
        user = self.example_user("hamlet")

        template = MessageTemplate.objects.create(
            realm=user.realm,
            user_profile=user,
            content="A saved message template",
        )

        self.assertEqual(template.title, "")

    def test_to_api_dict(self) -> None:
        user = self.example_user("hamlet")
        template = MessageTemplate.objects.create(
            realm=user.realm,
            user_profile=user,
            title="Quick reply",
            content="Thanks for reaching out!",
        )

        self.assertEqual(
            template.to_api_dict(),
            {
                "id": template.id,
                "title": "Quick reply",
                "content": "Thanks for reaching out!",
                "date_created": int(template.date_created.timestamp()),
                "date_updated": int(template.date_updated.timestamp()),
            },
        )
