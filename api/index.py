import os
import sys

# Ensure parent directory is in Python path for server and database modules
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if base_dir not in sys.path:
    sys.path.insert(0, base_dir)

from server import app
