from pydantic import BaseModel

class Node(BaseModel):
  id: int
  id_hex: str
  short_name: str
  long_name: str
