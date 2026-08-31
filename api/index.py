import os
import sys

cur_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.abspath(os.path.join(cur_dir, ".."))

for p in [root_dir, cur_dir]:
    if p not in sys.path:
        sys.path.insert(0, p)

from server import app
