from logging import disable
import bcrypt
from peewee import (
    FloatField,
    ForeignKeyField,
    fn,
    BooleanField,
    IntegerField,
    TextField,
)
from playhouse.shortcuts import model_to_dict

from .base import BaseModel


__all__ = ["User", "UserOptions"]


class UserOptions(BaseModel):
    fow_colour = TextField(default="#000", null=True)
    grid_colour = TextField(default="#000", null=True)
    ruler_colour = TextField(default="#F00", null=True)

    invert_alt = BooleanField(default=False, null=True)
    disable_scroll_to_zoom = BooleanField(default=False, null=True)

    use_high_dpi = BooleanField(default=False, null=True)
    grid_size = IntegerField(default=50, null=True)
    use_as_physical_board = BooleanField(default=False, null=True)
    mini_size = FloatField(default=1, null=True)
    ppi = IntegerField(default=96, null=True)

    initiative_camera_lock = BooleanField(default=False, null=True)
    initiative_vision_lock = BooleanField(default=False, null=True)
    initiative_effect_visibility = TextField(default="active", null=True)

    @classmethod
    def create_empty(cls):
        return UserOptions.create(
            fow_colour=None,
            grid_colour=None,
            ruler_colour=None,
            invert_alt=None,
            disable_scroll_to_zoom=None,
            use_high_dpi=None,
            grid_size=None,
            use_as_physical_board=None,
            initiative_camera_lock=None,
            initiative_vision_lock=None,
            initiative_effect_visibility=None,
        )

    def as_dict(self):
        return {
            k: v
            for k, v in model_to_dict(
                self, backrefs=None, recurse=None, exclude=[UserOptions.id]
            ).items()
            if v is not None
        }


class User(BaseModel):
    name = TextField()
    email = TextField(null=True)
    password_hash = TextField()
    default_options = ForeignKeyField(UserOptions, on_delete="CASCADE")

    def __repr__(self):
        return f"<User {self.name}>"

    def set_password(self, pw):
        pwhash = bcrypt.hashpw(pw.encode("utf8"), bcrypt.gensalt())
        self.password_hash = pwhash.decode("utf8")

    def check_password(self, pw):
        if self.password_hash is None:
            return False
        expected_hash = self.password_hash.encode("utf8")
        return bcrypt.checkpw(pw.encode("utf8"), expected_hash)

    def as_dict(self):
        return model_to_dict(
            self,
            recurse=False,
            exclude=[User.id, User.password_hash, User.default_options],
        )

    @classmethod
    def by_name(cls, name) -> "User":
        return cls.get_or_none(fn.Lower(cls.name) == name.lower())
