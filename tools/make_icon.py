"""exe 아이콘(.ico)을 만든다: python tools/make_icon.py build/icon.ico"""

import sys
from pathlib import Path

from jeongsi.icon import app_icon

target = Path(sys.argv[1] if len(sys.argv) > 1 else "build/icon.ico")
target.parent.mkdir(parents=True, exist_ok=True)
app_icon(size=256).save(target, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(target)
