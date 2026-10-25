from typing import Optional

from pydantic import BaseModel, Field


class UserAuth(BaseModel):
    username: str = Field(..., max_length=40)
    password: str = Field(..., max_length=128)
    avatar_url: Optional[str] = Field("", max_length=500)


class PlayerStatus(BaseModel):
    hp: int = 100
    sp: int = 100
    max_hp: int = 100
    max_sp: int = 100
