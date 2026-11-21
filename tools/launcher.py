"""PyInstaller 진입점(상대 import를 쓰는 패키지 __main__을 감싼다)."""

import sys

from jeongsi.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
