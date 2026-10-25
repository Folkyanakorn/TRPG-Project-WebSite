from pydantic import BaseModel
from typing import Optional

class UserAuth(BaseModel):
    username: str
    password: str
    avatar_url: Optional[str] = ""

class PlayerStatus(BaseModel):
    hp: int = 100
    sp: int = 50

class ChatMessage(BaseModel):
    sender: str
    text: str
    is_interrupt: bool = False
    avatar_url: Optional[str] = ""
