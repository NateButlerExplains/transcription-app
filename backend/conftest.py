"""Put the backend/ directory on sys.path so `from main import app` works
whether pytest is run from the repo root or from backend/."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
